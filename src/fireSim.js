import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, asin, atan, clamp, computeKernel, cross, dot, exp, float, floor, globalId, ivec3, length, max, min, mix,
	normalize, select, smoothstep, texture, texture3D, texture3DLoad, textureStore, uniform, uvec3, vec2, vec3, vec4
} from 'three/tsl';

import { BOX_MIN, BOX_SIZE, MOUTH_POS, JET_DIR, ROCK_CENTER, ROCK_RADIUS, LUT_TMAX } from './config.js';

// ---------------------------------------------------------------
// Simulação de gás 3D na GPU: cadeia fixa de compute shaders (TSL), 60 passos/s.
//
//   gas  (resolução cheia)  r fuligem · g temperatura · b combustível · a taxa de queima
//   vel  (metade)           xyz velocidade (m/s) · w taxa de expansão do gás queimando
//   prs  (metade, 32 bits)  r pressão · g divergência · b sólido   -> tudo que o Jacobi
//                           precisa fica pré-computado numa textura só
//   curl (metade)           vorticidade
//   light (1/4) / lightFar (1/8)  luz do fogo difundida · moonT (metade) sombra do luar
//
// gás:        advecção MacCormack (RK2 + turbulência sub-grade) -> fontes/combustão
// velocidade: advecção -> fontes (jato, empuxo, vento, pedra) -> vorticidade ->
//             confinamento + turbulência + viscosidade -> divergência -> Jacobi -> projeção
//
// A estrutura (duas grades, MacCormack só no gás, pressão em 32 bits, fuligem
// nascendo do calor perdido) segue o estudo do projeto force-field-vfx-threejs (MIT).
// ---------------------------------------------------------------

const WG = 4;
export const SIM_DT = 1 / 60;
export const SHAPE_W = 64, SHAPE_H = 24, SHAPE_MAX = 4.0;

const load = ( tex, coord ) => texture3DLoad( tex, coord ).toVar();
const sample = ( tex, uvw ) => texture3D( tex, uvw ).level( 0 );

function makeGrid( res ) {

	const [ nx, ny, nz ] = res;
	const n = vec3( nx, ny, nz );
	const top = ivec3( nx - 1, ny - 1, nz - 1 );
	const size = vec3( BOX_SIZE.x, BOX_SIZE.y, BOX_SIZE.z );
	const lo = vec3( BOX_MIN.x, BOX_MIN.y, BOX_MIN.z );
	const dispatchSize = res.map( ( v ) => Math.ceil( v / WG ) );
	const uvw = () => vec3( globalId ).add( 0.5 ).div( n );

	return {
		res, n, top, size, lo,
		h: BOX_SIZE.x / nx,
		cells: nx * ny * nz,
		coord: () => ivec3( globalId ),
		uvw,
		world: () => uvw().mul( size ).add( lo ),
		near: ( c, x, y, z ) => clamp( c.add( ivec3( x, y, z ) ), ivec3( 0 ), top ),
		store: ( tex, value ) => textureStore( tex, uvec3( globalId ), value ).toWriteOnly(),
		kernel( name, body ) {

			const k = computeKernel( Fn( body )(), [ WG, WG, WG ] );
			k.setName( name );
			k.dispatchSize = dispatchSize;
			return k;

		}
	};

}

function field( res, name, float32 = false ) {

	const t = new THREE.Storage3DTexture( res[ 0 ], res[ 1 ], res[ 2 ] );
	t.name = name;
	t.type = float32 ? THREE.FloatType : THREE.HalfFloatType;
	t.format = THREE.RGBAFormat;
	t.generateMipmaps = false;
	t.minFilter = t.magFilter = float32 ? THREE.NearestFilter : THREE.LinearFilter;
	t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
	return t;

}

export class FireSim {

	constructor( renderer, quality, lutTexture, noiseTexture, moonDir ) {

		this.renderer = renderer;

		const res = quality.grid;
		const half = res.map( ( v ) => v / 2 );
		const quarter = res.map( ( v ) => v / 4 );
		const eighth = res.map( ( v ) => v / 8 );

		const g = makeGrid( res );
		const v = makeGrid( half );
		const q4 = makeGrid( quarter );
		const q8 = makeGrid( eighth );

		// ---- uniforms -------------------------------------------------

		const u = this.uniforms = {
			dt: uniform( SIM_DT ),
			time: uniform( 0 ),

			// sopro
			mouth: uniform( MOUTH_POS.clone() ),
			jetDir: uniform( JET_DIR.clone() ),
			jetReach: uniform( MOUTH_POS.distanceTo( ROCK_CENTER ) ),
			jetFront: uniform( 0 ), // até onde a frente do sopro já chegou (m)
			jetTail: uniform( 0 ), // de onde o sopro já foi cortado (m)
			jetSpeed: uniform( 34 ),
			jetR0: uniform( 0.4 ),
			jetR1: uniform( 1.05 ),
			impact: uniform( 0 ), // 1 enquanto o jato bate na pedra
			fuelRich: uniform( 0.7 ), // quanto combustível o sopro carrega

			// combustão
			burnRate: uniform( 2.2 ),
			heat: uniform( 0.9 ),
			sootYield: uniform( 1.5 ),
			expansion: uniform( 1.6 ),
			cool: uniform( 1.6 ),
			sootFade: uniform( 0.42 ),

			// forças
			buoyancy: uniform( 3.4 ),
			weight: uniform( 0.05 ),
			drag: uniform( 0.6 ),
			wind: uniform( 4.0 ),
			push: uniform( 4.0 ),
			confine: uniform( 26 ),
			subgrid: uniform( 8 ),
			viscosity: uniform( 0.03 ),
			turbulence: uniform( 55 ),
			wrap: uniform( 22 ),

			// pedra
			rockBase: uniform( new THREE.Vector3( ROCK_CENTER.x, 0, ROCK_CENTER.z ) ),
			rockCenter: uniform( ROCK_CENTER.clone() ),
			rockRadius: uniform( ROCK_RADIUS ),
			rockSmoke: uniform( 0 ),

			moonDir: uniform( moonDir.clone().normalize() )
		};

		this.tunables = [
			[ u.jetSpeed, 'velocidade do jato', 5, 70 ], [ u.jetR0, 'raio na boca', 0.1, 1 ], [ u.jetR1, 'raio no alvo', 0.3, 2.5 ],
			[ u.fuelRich, 'combustível do sopro', 0.1, 1.5 ], [ u.burnRate, 'taxa de queima', 0.3, 8 ], [ u.heat, 'calor liberado', 0.2, 3 ], [ u.expansion, 'expansão do gás', 0, 6 ],
			[ u.cool, 'resfriamento', 0.1, 5 ], [ u.sootYield, 'fumaça do fogo', 0, 5 ], [ u.sootFade, 'dissipação da fumaça', 0, 2 ],
			[ u.buoyancy, 'empuxo', 0, 12 ], [ u.wind, 'vento', 0, 20 ], [ u.push, 'empurrão pós-impacto', 0, 20 ],
			[ u.confine, 'redemoinhos', 0, 80 ], [ u.turbulence, 'turbulência', 0, 150 ], [ u.subgrid, 'rasgo fino', 0, 20 ],
			[ u.viscosity, 'viscosidade', 0, 0.3 ], [ u.wrap, 'abraço na pedra', 0, 60 ]
		];

		// ---- campos ---------------------------------------------------

		const vel = [ field( half, 'velA' ), field( half, 'velB' ) ];
		const gas = [ field( res, 'gasA' ), field( res, 'gasB' ) ];
		const gasTmp = field( res, 'gasTmp' );
		const prs = [ field( half, 'prsA', true ), field( half, 'prsB', true ) ];
		const curlTex = field( half, 'curl' );
		const light = [ field( quarter, 'lightA' ), field( quarter, 'lightB' ) ];
		const lightFar = [ field( eighth, 'farA' ), field( eighth, 'farB' ) ];
		const moonT = field( half, 'moonT' );
		const lightSrc = field( quarter, 'lightSrc' );

		this.gasTex = gas[ 0 ];
		this.lightTex = light[ 0 ];
		this.lightFarTex = lightFar[ 0 ];
		this.moonTex = moonT;
		this.velNode = texture3D( vel[ 0 ] );
		this.lightNode = texture3D( light[ 0 ] );
		this.lightFarNode = texture3D( lightFar[ 0 ] );
		this.grid = g;

		// forma real da pedra: raio por direção a partir da base (mapa az × elevação),
		// preenchido na CPU pela malha que derrete -> o fogo contorna o que sobrou dela
		this.shapeData = new Uint8Array( SHAPE_W * SHAPE_H * 4 );
		const shapeTex = this.shapeTex = new THREE.DataTexture( this.shapeData, SHAPE_W, SHAPE_H, THREE.RGBAFormat, THREE.UnsignedByteType );
		shapeTex.minFilter = shapeTex.magFilter = THREE.LinearFilter;
		shapeTex.wrapS = THREE.RepeatWrapping;
		shapeTex.wrapT = THREE.ClampToEdgeWrapping;
		shapeTex.needsUpdate = true;

		// ---- helpers --------------------------------------------------

		const flow = ( w, period, shift ) => sample( noiseTexture, w.div( period ).add( shift ) ).xyz.mul( 2 ).sub( 1 );
		const noiseA = ( p ) => sample( noiseTexture, p ).a;
		const lutR = ( T ) => texture( lutTexture, vec2( T.div( LUT_TMAX ), 0.5 ) ).level( 0 ).r;

		// distância (m) à superfície da pedra: negativa por dentro
		const rockSD = ( w ) => {

			const rel = w.sub( u.rockBase );
			const r = max( length( rel ), 0.001 );
			const az = atan( rel.z, rel.x ).div( Math.PI * 2 ).add( 0.5 );
			const el = asin( clamp( rel.y.div( r ), 0.0, 1.0 ) ).div( Math.PI / 2 );
			const R = texture( shapeTex, vec2( az, el.mul( ( SHAPE_H - 1 ) / SHAPE_H ).add( 0.5 / SHAPE_H ) ) ).level( 0 ).r.mul( SHAPE_MAX );
			return r.sub( R );

		};

		// 0 perto das faces abertas da caixa; o chão fica fechado
		const sponge = ( uvw ) => smoothstep( 0, 0.07, min( min( uvw.x, uvw.x.oneMinus() ), min( min( uvw.z, uvw.z.oneMinus() ), uvw.y.oneMinus() ) ) );

		// o sopro: um cone da boca até a pedra, que serpenteia e "respira"
		const beamAt = ( w ) => {

			const along = dot( w.sub( u.mouth ), u.jetDir ).toVar();
			const t = clamp( along.div( u.jetReach ), 0, 1 ).toVar();
			const wob = sample( noiseTexture, vec3( t.mul( 0.12 ), u.time.mul( 0.05 ), 0.3 ) ).xyz.sub( 0.5 ).mul( t ).mul( 1.5 );
			const axis = u.mouth.add( u.jetDir.mul( clamp( along, 0, u.jetReach ) ) ).add( wob );
			// o raio pulsa ao longo do jato: as chamas lambem para fora em vez de formar um tubo
			const licks = noiseA( vec3( t.mul( 0.6 ).sub( u.time.mul( 0.55 ) ), u.time.mul( 0.12 ), 0.5 ) ).mul( 1.3 ).add( 0.35 );
			const radius = mix( u.jetR0, u.jetR1, t ).mul( licks ).toVar();
			const gate = smoothstep( - 0.05, 0.2, along )
				.mul( smoothstep( u.jetFront, u.jetFront.sub( 1.3 ), along ) )
				.mul( smoothstep( u.jetTail.sub( 0.9 ), u.jetTail, along ) );
			const core = smoothstep( radius.mul( 0.3 ), radius, length( w.sub( axis ) ) ).oneMinus().mul( gate ).toVar();
			const pulse = noiseA( vec3( t.mul( 0.4 ).sub( u.time.mul( 0.4 ) ), 0.2, 0.7 ) ).mul( 1.6 ).toVar();
			return { core, pulse, t };

		};

		// máscara de ocupação pré-computada (canal a da luz distante, 1/8 da resolução):
		// onde há gás ou fonte, dilatada 2 células. Fora dela não há nada a simular.
		const ACTIVE = 0.02;
		const isActive = ( uvw ) => sample( lightFar[ 0 ], uvw ).a.greaterThan( ACTIVE );

		const windDir = normalize( vec3( JET_DIR.x, 0, JET_DIR.z ) );
		const windAt = () => windDir.mul( u.wind );

		// ---- gás: advecção MacCormack ---------------------------------

		// retrocesso RK2 em uvw; scale converte m/s em uvw por passo
		const backtrace = ( velTex, uvw, scale ) => {

			const v1 = sample( velTex, uvw ).xyz;
			const v2 = sample( velTex, uvw.sub( v1.mul( scale ).mul( 0.5 ) ) ).xyz;
			return uvw.sub( v2.mul( scale ) ).toVar();

		};

		// idem, mais redemoinhos abaixo da grade de velocidade: gás rápido rasga, gás calmo fica liso
		const gasBack = ( uvw ) => {

			const scale = u.dt.div( g.size );
			const w = uvw.mul( g.size );
			const fine = flow( w, 4.5, u.time.mul( 0.09 ) ).add( flow( w.zxy, 2.3, u.time.mul( - 0.13 ) ).mul( 0.7 ) );
			const amp = length( sample( vel[ 0 ], uvw ).xyz ).mul( 0.06 ).add( 0.15 ).mul( u.subgrid );
			return backtrace( vel[ 0 ], uvw, scale ).sub( fine.mul( amp ).mul( scale ) ).toVar();

		};

		const advectForward = g.kernel( 'gasForward', () => {

			If( isActive( g.uvw() ), () => {

				g.store( gasTmp, sample( gas[ 0 ], gasBack( g.uvw() ) ) );

			} ).Else( () => {

				g.store( gasTmp, vec4( 0 ) );

			} );

		} );

		const advectCorrect = g.kernel( 'gasCorrect', () => {

			const uvw = g.uvw();
			const c = g.coord();

			If( isActive( uvw ).not(), () => {

				g.store( gas[ 1 ], vec4( 0 ) );

			} ).Else( () => {

			const from = gasBack( uvw );
			const hat = load( gasTmp, c );
			const bar = sample( gasTmp, uvw.mul( 2 ).sub( from ) );
			const fixed = hat.add( load( gas[ 0 ], c ).sub( bar ).mul( 0.5 ) );

			// limita às 8 células que o retrocesso leu: sem isso a correção "inventa" gás
			const base = ivec3( floor( from.mul( g.n ).sub( 0.5 ) ) ).toVar();
			let lo = load( gas[ 0 ], g.near( base, 0, 0, 0 ) );
			let hi = lo;

			for ( const [ x, y, z ] of [ [ 1, 0, 0 ], [ 0, 1, 0 ], [ 1, 1, 0 ], [ 0, 0, 1 ], [ 1, 0, 1 ], [ 0, 1, 1 ], [ 1, 1, 1 ] ] ) {

				const s = load( gas[ 0 ], g.near( base, x, y, z ) );
				lo = min( lo, s );
				hi = max( hi, s );

			}

			g.store( gas[ 1 ], max( min( fixed, hi ), lo ) );

			} );

		} );

		// ---- gás: jato, combustão, fuligem ----------------------------

		const gasSources = g.kernel( 'gasSources', () => {

			const w = g.world().toVar();
			const uvw = g.uvw();

			If( isActive( uvw ).not(), () => {

				g.store( gas[ 0 ], vec4( 0 ) );

			} ).Else( () => {

			const gs = load( gas[ 1 ], g.coord() );
			const soot = gs.x.toVar(), T = gs.y.toVar(), fuel = gs.z.toVar();

			// o jato é mantido quente no miolo e carrega combustível, mais rico perto do alvo
			const { core, pulse, t } = beamAt( w );
			fuel.assign( max( fuel, core.mul( pulse ).mul( smoothstep( 0.3, 0.9, t ).mul( 0.7 ).add( 0.3 ) ).mul( u.fuelRich ) ) );
			T.assign( max( T, core.mul( pulse.mul( 0.45 ).add( 0.5 ) ).add( smoothstep( 0.65, 1, core ).mul( pulse ).mul( 1.1 ) ) ) );

			// impacto: o jato alimenta um fogo na pele da pedra; daqui saem as chamas que a envolvem
			const toMouth = normalize( u.mouth.sub( u.rockCenter ) );
			const contact = u.rockCenter.add( toMouth.mul( u.rockRadius.add( 0.3 ) ) );
			const off = w.sub( contact );
			const gust = noiseA( w.mul( 0.05 ).add( vec3( u.time.mul( 0.25 ), 0.6, 0.1 ) ) ).mul( 1.4 );
			const flare = exp( dot( off, off ).mul( - 1.3 ) ).mul( u.impact ).mul( gust ).mul( u.fuelRich ).toVar();
			fuel.assign( max( fuel, flare ) );
			T.assign( max( T, flare.mul( 1.9 ) ) );

			const burn = min( fuel, u.burnRate.mul( u.dt ).mul( smoothstep( 0.1, 0.28, T ) ) ).toVar();
			fuel.subAssign( burn );
			T.addAssign( burn.mul( u.heat ) );

			// gás que desacelera (em relação ao vento) perde calor mais rápido, e o calor
			// perdido vira fuligem: o jato rápido fica limpo, a fumaça nasce das chamas
			const air = sample( vel[ 0 ], uvw ).xyz.sub( windAt() ).toVar();
			const slow = smoothstep( 5, 16, length( air ) ).oneMinus().toVar();
			const before = T.toVar();
			T.assign( T.mul( exp( u.cool.mul( slow.mul( 1.2 ).add( 1 ) ).negate().mul( u.dt ) ) ).sub( T.mul( T ).mul( T ).mul( T ).mul( u.dt ).mul( 0.4 ) ).max( 0 ) );
			soot.addAssign( before.sub( T ).mul( u.sootYield ).mul( slow ).mul( smoothstep( 0.35, 0.95, T ).oneMinus() ) );
			soot.mulAssign( exp( u.sootFade.negate().mul( u.dt ) ) );

			// a casca incandescente da pedra solta fumaça
			const sd = rockSD( w ).toVar();
			const n = noiseA( w.mul( 0.9 ).add( vec3( 0, u.time.mul( - 0.2 ), 0 ) ) );
			soot.addAssign( smoothstep( 0.35, 0.05, sd ).mul( u.rockSmoke ).mul( n ).mul( u.dt ) );

			// piso: resíduo invisível some de vez, senão a região nunca volta a ficar inativa
			soot.assign( max( soot.sub( 0.0004 ), 0 ) );
			T.assign( max( T.sub( 0.0004 ), 0 ) );

			const keep = smoothstep( - 0.06, 0.08, sd ).mul( sponge( uvw ) );
			g.store( gas[ 0 ], vec4( min( soot.mul( keep ), 4 ), min( T.mul( keep ), LUT_TMAX ), min( fuel.mul( keep ), 1 ), burn.div( u.dt ).mul( keep ) ) );

			} );

		} );

		// ---- velocidade -----------------------------------------------

		const advectVel = v.kernel( 'advectVel', () => {

			v.store( vel[ 1 ], vec4( sample( vel[ 0 ], backtrace( vel[ 0 ], v.uvw(), u.dt.div( v.size ) ) ).xyz, 0 ) );

		} );

		const velSources = v.kernel( 'velSources', () => {

			const w = v.world().toVar();
			const uvw = v.uvw();
			const vl = load( vel[ 1 ], v.coord() ).xyz.toVar();
			const gs = sample( gas[ 0 ], uvw ).toVar();

			const { core } = beamAt( w );
			vl.assign( mix( vl, u.jetDir.mul( u.jetSpeed ), core.mul( 0.92 ) ) );

			vl.addAssign( vec3( 0, u.buoyancy.mul( gs.y ).sub( u.weight.mul( gs.x ) ).mul( u.dt ), 0 ) );

			// o ar relaxa para um vento suave ao longo do sopro
			const wind = windAt().toVar();
			vl.assign( mix( wind, vl, exp( u.drag.negate().mul( u.dt ) ) ) );
			// empurrão de mão única: o que fica para trás ou volta contra o dragão é levado adiante
			const lag = max( u.wind.sub( dot( vl, windDir ) ), 0 );
			vl.addAssign( windDir.mul( lag ).mul( exp( u.push.negate().mul( u.dt ) ).oneMinus() ) );

			// pele da pedra: tira a componente que entra e puxa de leve as chamas em volta dela
			const sd = rockSD( w ).toVar();
			const nrm = normalize( w.sub( u.rockCenter ) );
			const skin = smoothstep( 0.0, 0.5, sd ).oneMinus();
			vl.subAssign( nrm.mul( min( dot( vl, nrm ), 0 ) ).mul( skin ) );
			vl.subAssign( nrm.mul( skin ).mul( u.wrap ).mul( u.dt ).mul( u.impact ) );

			// faces abertas relaxam para o vento, não para zero
			vl.assign( mix( wind, vl, sponge( uvw ).mul( 0.15 ).add( 0.85 ) ) );

			// passo de advecção abaixo de 6 células de gás: estável quando o jato bate na pedra
			const vmax = ( v.h / 2 ) * 6 * 60;
			const speed = max( length( vl ), 0.001 );
			const keep = smoothstep( - 0.05, 0.05, sd );
			v.store( vel[ 0 ], vec4( vl.mul( min( speed, vmax ).div( speed ) ).mul( keep ), gs.w.mul( u.expansion ).mul( keep ) ) );

		} );

		const curl = v.kernel( 'curl', () => {

			const c = v.coord();
			const x0 = load( vel[ 0 ], v.near( c, - 1, 0, 0 ) ), x1 = load( vel[ 0 ], v.near( c, 1, 0, 0 ) );
			const y0 = load( vel[ 0 ], v.near( c, 0, - 1, 0 ) ), y1 = load( vel[ 0 ], v.near( c, 0, 1, 0 ) );
			const z0 = load( vel[ 0 ], v.near( c, 0, 0, - 1 ) ), z1 = load( vel[ 0 ], v.near( c, 0, 0, 1 ) );
			const wv = vec3(
				y1.z.sub( y0.z ).sub( z1.y.sub( z0.y ) ),
				z1.x.sub( z0.x ).sub( x1.z.sub( x0.z ) ),
				x1.y.sub( x0.y ).sub( y1.x.sub( y0.x ) )
			).div( 2 * v.h ).toVar();
			v.store( curlTex, vec4( wv, length( wv ) ) );

		} );

		// confinamento de vorticidade + turbulência sem divergência + viscosidade
		// (gás quente é mais viscoso: dá as dobras grossas e rolantes da chama)
		const confine = v.kernel( 'confine', () => {

			const c = v.coord();
			const wv = load( curlTex, c );
			const grad = vec3(
				load( curlTex, v.near( c, 1, 0, 0 ) ).w.sub( load( curlTex, v.near( c, - 1, 0, 0 ) ).w ),
				load( curlTex, v.near( c, 0, 1, 0 ) ).w.sub( load( curlTex, v.near( c, 0, - 1, 0 ) ).w ),
				load( curlTex, v.near( c, 0, 0, 1 ) ).w.sub( load( curlTex, v.near( c, 0, 0, - 1 ) ).w )
			).toVar();
			const N = grad.div( max( length( grad ), 0.0001 ) );
			const force = cross( N, wv.xyz ).mul( u.confine ).mul( v.h );

			const gs = sample( gas[ 0 ], v.uvw() );
			const vl = load( vel[ 0 ], c );
			const w = v.world();
			const t = u.time;
			const eddies = flow( w, 16, vec3( 0, t.mul( - 0.05 ), t.mul( 0.03 ) ) ).add( flow( w.yzx, 9, vec3( t.mul( 0.07 ), 0, t.mul( - 0.04 ) ) ).mul( 0.7 ) );
			const stir = gs.y.add( gs.x.mul( 0.3 ) ).add( length( vl.xyz ).mul( 0.04 ) );
			const shred = eddies.mul( stir ).mul( u.turbulence );

			const nb = ( x, y, z ) => load( vel[ 0 ], v.near( c, x, y, z ) ).xyz;
			const avg = nb( 1, 0, 0 ).add( nb( - 1, 0, 0 ) ).add( nb( 0, 1, 0 ) ).add( nb( 0, - 1, 0 ) ).add( nb( 0, 0, 1 ) ).add( nb( 0, 0, - 1 ) ).div( 6 );
			const nu = u.viscosity.mul( gs.y.mul( 2 ).add( 1 ) );
			const blend = clamp( nu.mul( u.dt ).mul( 6 / ( v.h * v.h ) ), 0, 0.8 );
			v.store( vel[ 1 ], vec4( mix( vl.xyz, avg, blend ).add( force.add( shred ).mul( u.dt ) ), vl.w ) );

		} );

		// divergência e máscara de sólido: gravadas uma vez, lidas pelo Jacobi inteiro
		const divergence = v.kernel( 'divergence', () => {

			const c = v.coord();
			const w = v.world().toVar();
			const solidAt = ( p ) => rockSD( p ).lessThan( 0.0 );
			const flux = ( x, y, z, axis ) => {

				const vn = load( vel[ 1 ], v.near( c, x, y, z ) );
				return select( solidAt( w.add( vec3( x, y, z ).mul( v.h ) ) ), float( 0 ), vn[ axis ] );

			};

			const floorV = select( c.y.equal( 0 ), float( 0 ), flux( 0, - 1, 0, 'y' ) );
			const div = flux( 1, 0, 0, 'x' ).sub( flux( - 1, 0, 0, 'x' ) )
				.add( flux( 0, 1, 0, 'y' ) ).sub( floorV )
				.add( flux( 0, 0, 1, 'z' ) ).sub( flux( 0, 0, - 1, 'z' ) ).div( 2 * v.h )
				.sub( load( vel[ 1 ], c ).w );

			// partida quente: a pressão do passo anterior é um bom chute
			v.store( prs[ 1 ], vec4( load( prs[ 0 ], c ).x.mul( 0.96 ), div, select( solidAt( w ), float( 1 ), float( 0 ) ), 0 ) );

		} );

		const jacobi = ( src, dst ) => v.kernel( 'jacobi', () => {

			const c = v.coord();
			const me = load( src, c );
			const open = ( x, y, z, border ) => {

				const n = load( src, v.near( c, x, y, z ) );
				return select( border, float( 0 ), select( n.z.greaterThan( 0.5 ), me.x, n.x ) );

			};

			const xLo = open( - 1, 0, 0, c.x.equal( 0 ) );
			const xHi = open( 1, 0, 0, c.x.equal( v.res[ 0 ] - 1 ) );
			const yLo = select( c.y.equal( 0 ), me.x, open( 0, - 1, 0, c.y.lessThan( 0 ) ) );
			const yHi = open( 0, 1, 0, c.y.equal( v.res[ 1 ] - 1 ) );
			const zLo = open( 0, 0, - 1, c.z.equal( 0 ) );
			const zHi = open( 0, 0, 1, c.z.equal( v.res[ 2 ] - 1 ) );
			const p = xLo.add( xHi ).add( yLo ).add( yHi ).add( zLo ).add( zHi ).sub( me.y.mul( v.h * v.h ) ).div( 6 );
			v.store( dst, vec4( p, me.y, me.z, 0 ) );

		} );

		const project = v.kernel( 'project', () => {

			const c = v.coord();
			const me = load( prs[ 0 ], c );
			const grad = ( x, y, z, keepFloor ) => {

				const a = load( prs[ 0 ], v.near( c, x, y, z ) );
				const b = load( prs[ 0 ], v.near( c, - x, - y, - z ) );
				const pa = select( a.z.greaterThan( 0.5 ), me.x, a.x );
				const pb = select( b.z.greaterThan( 0.5 ).or( keepFloor ), me.x, b.x );
				return pa.sub( pb );

			};

			const never = c.x.lessThan( 0 );
			const g3 = vec3( grad( 1, 0, 0, never ), grad( 0, 1, 0, c.y.equal( 0 ) ), grad( 0, 0, 1, never ) ).div( 2 * v.h );
			const vl = load( vel[ 1 ], c );
			const out = vl.xyz.sub( g3 ).mul( float( 1 ).sub( me.z ) );
			const y = select( c.y.equal( 0 ), out.y.max( 0 ), out.y );
			v.store( vel[ 0 ], vec4( out.x, y, out.z, vl.w ) );

		} );

		// ---- luz ------------------------------------------------------

		const extinction = ( s ) => s.x.mul( 1.9 ).add( s.y.mul( 0.4 ) );
		const FIRE_TINT = vec3( 1, 0.3, 0.045 ); // luz laranja pura: somar o branco do núcleo lavaria a cena

		// coleta, uma vez por frame: emissão, opacidade e presença de cada célula de 1/4.
		// 8 amostras trilineares a ±1 célula de gás cobrem exatamente as 4³ células dela.
		const gather = q4.kernel( 'lightGather', () => {

			const s = vec4( 0 ).toVar();
			for ( const sx of [ - 1, 1 ] ) for ( const sy of [ - 1, 1 ] ) for ( const sz of [ - 1, 1 ] ) {

				s.addAssign( sample( gas[ 0 ], q4.uvw().add( vec3( sx, sy, sz ).div( g.n ) ) ) );

			}

			s.mulAssign( 0.125 );

			// presença: gás aqui, ou uma fonte que vai criar gás (sopro, impacto, casca da pedra)
			const w = q4.world();
			const toMouth = normalize( u.mouth.sub( u.rockCenter ) );
			const offc = w.sub( u.rockCenter.add( toMouth.mul( u.rockRadius.add( 0.3 ) ) ) );
			const presence = s.x.add( s.y ).add( s.z )
				.add( beamAt( w ).core )
				.add( exp( dot( offc, offc ).mul( - 0.6 ) ).mul( u.impact ) )
				.add( smoothstep( 0.8, 0.2, rockSD( w ) ).mul( min( u.rockSmoke, 1.0 ) ) );

			const dim = exp( extinction( s ).mul( q4.h ).mul( 0.1 ).negate() );
			q4.store( lightSrc, vec4( lutR( s.y ).mul( 0.07 ), dim.mul( 0.992 ), 0, presence ) );

		} );

		// luz próxima: a emissão difunde e escurece ao atravessar fuligem
		const diffuse = ( src, dst ) => q4.kernel( 'lightDiffuse', () => {

			const c = q4.coord();
			const e = load( lightSrc, c );
			const nb = ( x, y, z ) => load( src, q4.near( c, x, y, z ) ).xyz;
			const avg = nb( 1, 0, 0 ).add( nb( - 1, 0, 0 ) ).add( nb( 0, 1, 0 ) ).add( nb( 0, - 1, 0 ) ).add( nb( 0, 0, 1 ) ).add( nb( 0, 0, - 1 ) ).div( 6 );
			q4.store( dst, vec4( FIRE_TINT.mul( e.x ).add( avg.mul( e.y ) ), e.w ) );

		} );

		// luz distante: células grandes e perda mínima para atravessar a cena inteira
		const spread = ( src, dst ) => q8.kernel( 'lightFar', () => {

			const c = q8.coord();
			const me = load( src, c ).xyz;
			const face = ( x, y, z, edge ) => select( edge, me.mul( 0.6 ), load( src, q8.near( c, x, y, z ) ).xyz );
			const occN = ( x, y, z ) => load( src, q8.near( c, x, y, z ) ).a;
			const around = max( max( max( occN( 1, 0, 0 ), occN( - 1, 0, 0 ) ), max( occN( 0, 1, 0 ), occN( 0, - 1, 0 ) ) ), max( occN( 0, 0, 1 ), occN( 0, 0, - 1 ) ) );
			const here = sample( light[ 0 ], q8.uvw() ).a.greaterThan( 0.0005 ).select( float( 1 ), float( 0 ) );
			const occ = max( here, around.sub( 0.4 ) );
			const top = eighth.map( ( n ) => n - 1 );
			const avg = face( 1, 0, 0, c.x.equal( top[ 0 ] ) ).add( face( - 1, 0, 0, c.x.equal( 0 ) ) )
				.add( face( 0, 1, 0, c.y.equal( top[ 1 ] ) ) ).add( load( src, q8.near( c, 0, - 1, 0 ) ).xyz )
				.add( face( 0, 0, 1, c.z.equal( top[ 2 ] ) ) ).add( face( 0, 0, - 1, c.z.equal( 0 ) ) ).div( 6 );
			q8.store( dst, vec4( sample( light[ 0 ], q8.uvw() ).xyz.mul( 0.02 ).add( avg.mul( 0.995 ) ), occ ) );

		} );

		// sombra do luar pré-computada: um raio curto por célula dá o volume das dobras da fumaça
		const moonShadow = v.kernel( 'moonShadow', () => {

			const w = v.world().toVar();
			const STEP = 0.42;
			const tau = float( 0 ).toVar();

			Loop( 12, ( { i } ) => {

				const at = w.add( u.moonDir.mul( float( i ).add( 0.7 ).mul( STEP ) ) );
				tau.addAssign( extinction( sample( gas[ 0 ], at.sub( v.lo ).div( v.size ) ) ) );

			} );

			v.store( moonT, vec4( exp( tau.mul( STEP ).mul( 1.7 ).negate() ), 0, 0, 1 ) );

		} );

		// ---- cadeias --------------------------------------------------
		// começam e terminam no índice 0 de cada par: nada de troca de textura nem bind group refeito

		// presets leves: advecção semi-Lagrangiana direta (um passe a menos, gás um pouco mais borrado)
		const advectSimple = g.kernel( 'gasAdvect', () => {

			If( isActive( g.uvw() ), () => {

				g.store( gas[ 1 ], sample( gas[ 0 ], gasBack( g.uvw() ) ) );

			} ).Else( () => {

				g.store( gas[ 1 ], vec4( 0 ) );

			} );

		} );

		this.gasPasses = quality.mac ? [ advectForward, advectCorrect, gasSources ] : [ advectSimple, gasSources ];
		this.velPasses = [ advectVel, velSources, curl, confine, divergence ];

		const odd = jacobi( prs[ 1 ], prs[ 0 ] );
		const even = jacobi( prs[ 0 ], prs[ 1 ] );
		for ( let i = 0; i < quality.jacobi; i += 2 ) this.velPasses.push( odd, even );
		this.velPasses.push( odd, project );

		this.lightPasses = [ moonShadow, gather ];
		const a = diffuse( light[ 0 ], light[ 1 ] ), b = diffuse( light[ 1 ], light[ 0 ] );
		for ( let i = 0; i < 6; i ++ ) this.lightPasses.push( a, b );
		const c = spread( lightFar[ 0 ], lightFar[ 1 ] ), d = spread( lightFar[ 1 ], lightFar[ 0 ] );
		for ( let i = 0; i < 6; i ++ ) this.lightPasses.push( c, d );

		this.passes = [ ...this.gasPasses, ...this.velPasses ];
		this.frame = 0;

	}

	step() {

		this.uniforms.time.value = ( this.frame * SIM_DT ) % 4096;
		this.renderer.compute( this.passes );
		this.frame ++;

	}

	relight() {

		this.renderer.compute( this.lightPasses );

	}

}
