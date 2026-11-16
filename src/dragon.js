import * as THREE from 'three/webgpu';
import {
	vec2, vec3, float, uniform, texture, uv, positionWorld, normalWorld, positionLocal, normalLocal,
	smoothstep, mix, bumpMap, sin, max
} from 'three/tsl';

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { MOUTH_POS, JET_DIR } from './config.js';
import { loadTexture, heightOf } from './environment.js';
import { triplanar } from './rock.js';

// ---------------------------------------------------------------
// Dragão procedural (wyvern: as asas são os braços), modelado em código a
// partir do concept gerado no Codex: escamas carvão, escudos vermelhos na
// barriga do queixo à cauda, membranas vermelhas, chifres e garras cor de osso.
//  - corpo/pescoço/cauda: tubo regenerado a cada frame sobre uma espinha animada
//  - cabeça: crânio e mandíbula "lofted", coroa de chifres, dentes, língua, olhos
//  - pernas digitígradas com garras; asas com ossos, juntas e membrana recortada
//  - a garganta acende entre os escudos quando ele cospe fogo
// ---------------------------------------------------------------

const V = ( x, y, z ) => new THREE.Vector3( x, y, z );
const RINGS = 150, SEGS = 28;
const BODY_U = 8, BODY_V = 22; // repetições da textura em volta / ao longo do corpo

export function createDragon( scene, fireGI, noiseTexture ) {

	const root = new THREE.Group();
	scene.add( root );

	const uFire = uniform( 0 );
	const scalesTex = loadTexture( '/textures/scales.png' );
	const bellyTex = loadTexture( '/textures/belly.png' );
	const wingTex = loadTexture( '/textures/wing.png' );

	const SKIN_TINT = vec3( 0.66, 0.55, 0.52 );
	const RED_TINT = vec3( 1.25, 0.34, 0.3 );

	// ---- materiais ------------------------------------------------------

	// corpo: escamas no dorso e nos flancos, escudos vermelhos na barriga
	const bodyMat = new THREE.MeshStandardNodeMaterial( { metalness: 0.0 } );
	{

		const around = uv().x.div( BODY_U ).fract(); // 0 = dorso, 0.5 = barriga
		const side = around.sub( 0.5 ).abs();
		const belly = smoothstep( 0.165, 0.115, side );
		const sc = texture( scalesTex, uv() );
		const scuteUV = vec2( around.sub( 0.5 ).mul( 2.4 ).add( 0.5 ), uv().y.mul( 0.34 ) );
		const st = texture( bellyTex, scuteUV );

		const albedo = mix( sc.rgb.mul( SKIN_TINT ).mul( 1.6 ), st.rgb.mul( 1.1 ), belly );
		const h = mix( heightOf( sc ), heightOf( st ), belly );

		bodyMat.colorNode = albedo;
		bodyMat.roughnessNode = mix( float( 0.74 ).sub( h.mul( 0.4 ) ), float( 0.5 ).sub( h.mul( 0.2 ) ), belly );
		bodyMat.normalNode = bumpMap( h, mix( float( 2.8 ), float( 3.6 ), belly ) );

		// garganta: o fogo aparece nas frestas entre os escudos, do peito até o queixo
		const along = smoothstep( 0.72, 0.97, uv().y.div( BODY_V ) );
		const gaps = smoothstep( 0.075, 0.025, heightOf( st ) ); // só as frestas escuras entre as placas
		const glow = vec3( 3.0, 0.55, 0.04 ).mul( gaps.add( 0.035 ) ).mul( belly ).mul( along ).mul( uFire );
		bodyMat.emissiveNode = fireGI( positionWorld, normalWorld ).mul( albedo ).mul( 0.9 ).add( glow );

	}

	// cabeça e membros: escamas triplanares, parte de baixo avermelhada
	function skinMaterial( scale ) {

		const m = new THREE.MeshStandardNodeMaterial( { metalness: 0.0 } );
		const tex = triplanar( scalesTex, positionLocal, normalLocal, scale );
		const h = heightOf( tex );
		const under = smoothstep( - 0.3, - 0.8, normalLocal.y ).mul( 0.75 );
		const albedo = tex.rgb.mul( mix( SKIN_TINT, RED_TINT, under ) ).mul( 1.6 );
		m.colorNode = albedo;
		m.roughnessNode = float( 0.72 ).sub( h.mul( 0.4 ) );
		m.normalNode = bumpMap( h, 2.8 );
		m.emissiveNode = fireGI( positionWorld, normalWorld ).mul( albedo ).mul( 0.9 );
		return m;

	}

	const headMat = skinMaterial( 1.7 );
	const limbMat = skinMaterial( 0.85 );

	// chifres, espinhos e garras: queratina escura na base, osso na ponta, com anéis
	const hornMat = new THREE.MeshStandardNodeMaterial( { metalness: 0.0 } );
	{

		const t = uv().y;
		const rings = sin( t.mul( 70.0 ) ).mul( 0.5 ).add( 0.5 );
		const col = mix( vec3( 0.06, 0.045, 0.04 ), vec3( 0.5, 0.41, 0.3 ), smoothstep( 0.1, 0.95, t ) ).mul( rings.mul( 0.25 ).add( 0.75 ) );
		hornMat.colorNode = col;
		hornMat.roughnessNode = float( 0.5 ).sub( t.mul( 0.2 ) );
		hornMat.normalNode = bumpMap( rings, 0.8 );
		hornMat.emissiveNode = fireGI( positionWorld, normalWorld ).mul( col ).mul( 0.9 );

	}

	const toothMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.32 } );
	toothMat.colorNode = vec3( 0.7, 0.63, 0.5 );
	toothMat.emissiveNode = fireGI( positionWorld, normalWorld ).mul( 0.6 ).add( vec3( 1.3, 0.32, 0.03 ).mul( uFire ) );

	const tongueMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.3 } );
	tongueMat.colorNode = vec3( 0.42, 0.06, 0.05 );
	tongueMat.emissiveNode = vec3( 2.4, 0.5, 0.05 ).mul( uFire ).add( fireGI( positionWorld, normalWorld ).mul( 0.3 ) );

	// olho: íris âmbar com pupila em fenda, brilha mais quando ele cospe
	const eyeMat = new THREE.MeshBasicNodeMaterial();
	{

		const p = positionLocal.normalize();
		const front = smoothstep( 0.15, 0.7, p.z );
		const slit = smoothstep( 0.05, 0.17, p.x.abs() );
		const iris = mix( vec3( 1.9, 0.5, 0.04 ), vec3( 2.6, 1.5, 0.25 ), smoothstep( 0.6, 0.1, p.xy.length() ) );
		eyeMat.colorNode = mix( vec3( 0.02, 0.008, 0.006 ), iris.mul( slit ), front ).mul( uFire.mul( 1.2 ).add( 1.0 ) );

	}

	const mouthMat = new THREE.MeshBasicNodeMaterial();
	mouthMat.colorNode = mix( vec3( 0.05, 0.008, 0.006 ), vec3( 7.0, 2.4, 0.4 ), uFire );

	const wingMat = new THREE.MeshStandardNodeMaterial( { side: THREE.DoubleSide, metalness: 0.0 } );
	{

		const t = texture( wingTex, uv().mul( vec2( 2.2, 2.6 ) ) );
		// mais escura junto aos ossos (bordas do painel) e na raiz
		const shade = smoothstep( 0.0, 0.18, uv().y ).mul( 0.55 ).add( 0.45 );
		const albedo = t.rgb.mul( vec3( 1.5, 1.2, 1.2 ) ).mul( shade );
		wingMat.colorNode = albedo;
		wingMat.roughnessNode = float( 0.66 ).sub( heightOf( t ).mul( 0.25 ) );
		wingMat.normalNode = bumpMap( heightOf( t ), 1.8 );
		// membrana fina: a luz do fogo atravessa e ela acende em vermelho
		wingMat.emissiveNode = fireGI( positionWorld, vec3( 0 ) ).mul( albedo.mul( vec3( 2.0, 0.75, 0.55 ) ) ).mul( 1.6 );

	}

	// ---- geometria: tubos e cones ----------------------------------------

	const _t = V(), _n = V(), _b = V(), _p = V(), _v = V(), _up = V( 0, 1, 0 ), _z = V( 0, 0, 1 );

	function writeTube( geo, pts, radiusFn, rings, segs ) {

		const pos = geo.attributes.position.array;
		const n = pts.length;

		for ( let i = 0; i < rings; i ++ ) {

			const t = i / ( rings - 1 );
			const f = t * ( n - 1 );
			const i0 = Math.min( n - 2, Math.floor( f ) );
			_p.lerpVectors( pts[ i0 ], pts[ i0 + 1 ], f - i0 );
			_t.subVectors( pts[ Math.min( n - 1, i0 + 2 ) ], pts[ Math.max( 0, i0 - 1 ) ] ).normalize();
			_b.crossVectors( _t, _up );
			if ( _b.lengthSq() < 1e-5 ) _b.copy( _z );
			_b.normalize();
			_n.crossVectors( _b, _t ).normalize();

			const [ rx, ry, ridge = 0, keel = 0 ] = radiusFn( t );
			const cap = ( i === 0 || i === rings - 1 ) ? 0.02 : 1;

			for ( let j = 0; j <= segs; j ++ ) {

				const ang = j / segs * Math.PI * 2; // 0 = dorso, PI = barriga
				const c = Math.cos( ang ), s = Math.sin( ang );
				const top = Math.pow( Math.max( c, 0 ), 6 ) * ridge; // crista no dorso
				const low = Math.pow( Math.max( - c, 0 ), 3 ) * keel; // quilha do peito
				const k = ( i * ( segs + 1 ) + j ) * 3;
				const ny = c * ry * ( 1 + top + low ) * cap, nz = s * rx * cap;
				pos[ k ] = _p.x + _n.x * ny + _b.x * nz;
				pos[ k + 1 ] = _p.y + _n.y * ny + _b.y * nz;
				pos[ k + 2 ] = _p.z + _n.z * ny + _b.z * nz;

			}

		}

		geo.attributes.position.needsUpdate = true;
		geo.computeVertexNormals();

	}

	function makeTubeGeometry( rings, segs, vRepeat = 1, uRepeat = 1 ) {

		const geo = new THREE.BufferGeometry();
		const count = rings * ( segs + 1 );
		const uvs = new Float32Array( count * 2 );
		const idx = [];

		for ( let i = 0; i < rings; i ++ ) for ( let j = 0; j <= segs; j ++ ) {

			const k = i * ( segs + 1 ) + j;
			uvs[ k * 2 ] = j / segs * uRepeat;
			uvs[ k * 2 + 1 ] = i / ( rings - 1 ) * vRepeat;
			if ( i < rings - 1 && j < segs ) idx.push( k, k + 1, k + segs + 1, k + 1, k + segs + 2, k + segs + 1 );

		}

		geo.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( count * 3 ), 3 ) );
		geo.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
		geo.setIndex( idx );
		return geo;

	}

	// tubo estático sobre uma curva; radiusFn devolve um raio ou [lateral, vertical]
	function tube( points, radiusFn, rings = 14, segs = 10 ) {

		const curve = new THREE.CatmullRomCurve3( points ).getPoints( rings * 2 );
		const geo = makeTubeGeometry( rings, segs );
		writeTube( geo, curve, ( t ) => { const r = radiusFn( t ); return Array.isArray( r ) ? r : [ r, r ]; }, rings, segs );
		return geo;

	}

	// espinho/garra/chifre curvo: afina até a ponta
	const spike = ( base, mid, tip, radius, rings = 10, segs = 7 ) => tube( [ base, mid, tip ], ( t ) => radius * Math.pow( 1 - t, 0.85 ) + radius * 0.04, rings, segs );
	const straight = ( base, tip, radius, rings = 6, segs = 6 ) => spike( base, base.clone().lerp( tip, 0.5 ), tip, radius, rings, segs );

	function blob( center, radius, scale ) {

		const g = new THREE.SphereGeometry( radius, 16, 12 );
		g.scale( scale.x, scale.y, scale.z );
		g.translate( center.x, center.y, center.z );
		return g;

	}

	const mesh = ( parts, material, parent = root, shadow = true ) => {

		const m = new THREE.Mesh( Array.isArray( parts ) ? mergeGeometries( parts ) : parts, material );
		m.castShadow = shadow;
		m.receiveShadow = shadow;
		parent.add( m );
		return m;

	};

	// ---- espinha: cauda -> quadril -> ombros -> pescoço -> cabeça ---------

	const headDir = JET_DIR.clone();
	const headUp = V();
	const headSide = V( 0, 0, 1 );
	const headBase = V();
	const HEAD_MOUTH = V( 1.55, - 0.22, 0 ); // de onde o fogo sai, no espaço da cabeça

	const spineRest = [
		V( - 19.6, 0.3, 3.9 ), V( - 18.0, 0.36, 2.7 ), V( - 16.2, 0.5, 1.45 ), V( - 14.4, 0.9, 0.45 ),
		V( - 12.8, 1.75, 0.0 ), V( - 11.4, 2.45, 0 ), V( - 10.1, 2.85, 0 ), V( - 9.0, 3.2, 0 ),
		V( - 8.25, 3.9, 0 ), V( - 7.8, 4.75, 0 ), V( - 7.3, 5.25, 0 ), V( - 6.65, 5.05, 0 ),
		V( 0, 0, 0 ) // base da cabeça (preenchida a cada frame)
	];
	const spine = spineRest.map( ( p ) => p.clone() );
	const spineCurve = new THREE.CatmullRomCurve3( spine, false, 'centripetal' );
	const spineSamples = Array.from( { length: 200 }, () => V() );

	// raio ao longo da espinha
	const prof = [
		[ 0.00, 0.035 ], [ 0.15, 0.19 ], [ 0.3, 0.4 ], [ 0.42, 0.82 ], [ 0.5, 1.1 ], [ 0.6, 1.24 ],
		[ 0.7, 1.08 ], [ 0.77, 0.68 ], [ 0.84, 0.47 ], [ 0.93, 0.38 ], [ 1.0, 0.34 ]
	];

	const radiusAt = ( t ) => {

		for ( let i = 0; i < prof.length - 1; i ++ ) {

			if ( t <= prof[ i + 1 ][ 0 ] ) {

				const k = ( t - prof[ i ][ 0 ] ) / ( prof[ i + 1 ][ 0 ] - prof[ i ][ 0 ] );
				return prof[ i ][ 1 ] + ( prof[ i + 1 ][ 1 ] - prof[ i ][ 1 ] ) * k * k * ( 3 - 2 * k );

			}

		}

		return prof[ prof.length - 1 ][ 1 ];

	};

	let breath = 0;
	const bodyRadius = ( t ) => {

		const r = radiusAt( t );
		const chest = Math.exp( - Math.pow( ( t - 0.63 ) / 0.09, 2 ) );
		const swell = 1 + chest * breath;
		// peito fundo com quilha, cauda e pescoço mais altos do que largos
		return [ r * ( 0.96 + chest * 0.08 ) * swell, r * ( 0.96 + chest * 0.1 ) * swell, 0.2, chest * 0.16 ];

	};

	const bodyGeo = makeTubeGeometry( RINGS, SEGS, BODY_V, BODY_U );
	const body = new THREE.Mesh( bodyGeo, bodyMat );
	body.castShadow = true; body.receiveShadow = true; body.frustumCulled = false;
	root.add( body );

	// espinhos dorsais (instanciados, seguem a espinha animada)
	const SPIKES = 58;
	const spikeGeo = new THREE.ConeGeometry( 0.5, 1, 6, 3 );
	spikeGeo.translate( 0, 0.5, 0 );
	const spikes = new THREE.InstancedMesh( spikeGeo, hornMat, SPIKES );
	spikes.castShadow = true; spikes.frustumCulled = false;
	root.add( spikes );
	const dummy = new THREE.Object3D();

	// ---- cabeça ---------------------------------------------------------

	const head = new THREE.Group();
	root.add( head );

	function loft( sections, segs = 22 ) {

		// sections: [x, meiaLargura, topo, fundo]
		const pos = [], idx = [];
		const n = sections.length;

		for ( let i = 0; i < n; i ++ ) {

			const [ x, w, top, bot ] = sections[ i ];
			const cy = ( top + bot ) / 2;

			for ( let j = 0; j <= segs; j ++ ) {

				const a = j / segs * Math.PI * 2;
				const c = Math.cos( a ), s = Math.sin( a );
				const z = Math.sign( s ) * Math.pow( Math.abs( s ), 0.72 ) * w;
				const y = c >= 0 ? cy + Math.pow( c, 0.75 ) * ( top - cy ) : cy - Math.pow( - c, 0.9 ) * ( cy - bot );
				pos.push( x, y, z );
				if ( i < n - 1 && j < segs ) {

					const k = i * ( segs + 1 ) + j;
					idx.push( k, k + segs + 1, k + 1, k + 1, k + segs + 1, k + segs + 2 );

				}

			}

		}

		for ( const end of [ 0, n - 1 ] ) {

			const [ x, , top, bot ] = sections[ end ];
			const c = pos.length / 3;
			pos.push( x, ( top + bot ) / 2, 0 );
			for ( let j = 0; j < segs; j ++ ) {

				const k = end * ( segs + 1 ) + j;
				if ( end === 0 ) idx.push( c, k, k + 1 ); else idx.push( c, k + 1, k );

			}

		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
		geo.setIndex( idx );
		geo.computeVertexNormals();
		return geo;

	}

	const interp = ( sections, x ) => {

		for ( let i = 0; i < sections.length - 1; i ++ ) {

			const a = sections[ i ], b = sections[ i + 1 ];
			if ( x <= b[ 0 ] ) { const k = Math.max( 0, ( x - a[ 0 ] ) / ( b[ 0 ] - a[ 0 ] ) ); return a.map( ( v, j ) => v + ( b[ j ] - v ) * k ); }

		}

		return sections[ sections.length - 1 ];

	};

	// crânio: nuca larga, arcada da sobrancelha alta, focinho longo com a ponta mais cheia
	const skullS = [
		[ - 0.16, 0.25, 0.25, - 0.2 ], [ 0.05, 0.37, 0.39, - 0.18 ], [ 0.28, 0.45, 0.45, - 0.14 ], [ 0.5, 0.42, 0.46, - 0.11 ],
		[ 0.68, 0.33, 0.33, - 0.09 ], [ 0.9, 0.26, 0.23, - 0.075 ], [ 1.15, 0.23, 0.2, - 0.07 ], [ 1.4, 0.215, 0.195, - 0.065 ],
		[ 1.6, 0.2, 0.2, - 0.06 ], [ 1.76, 0.15, 0.14, - 0.05 ], [ 1.86, 0.07, 0.06, - 0.035 ], [ 1.9, 0.02, 0.02, - 0.02 ]
	];
	mesh( loft( skullS ), headMat, head );

	const headSkin = [];
	const headHorn = [];

	for ( const s of [ - 1, 1 ] ) {

		// arcada da sobrancelha, crista nasal e narinas
		headSkin.push( tube( [ V( 0.24, 0.4, s * 0.31 ), V( 0.5, 0.48, s * 0.33 ), V( 0.76, 0.34, s * 0.25 ), V( 1.1, 0.23, s * 0.17 ), V( 1.5, 0.21, s * 0.13 ) ], ( t ) => 0.09 * ( 1 - t * 0.55 ), 12, 8 ) );
		headSkin.push( tube( [ V( 1.55, 0.2, s * 0.1 ), V( 1.72, 0.2, s * 0.11 ), V( 1.84, 0.11, s * 0.08 ) ], ( t ) => 0.055 * ( 1 - t * 0.4 ), 6, 7 ) );
		// bochecha / músculo da mandíbula
		headSkin.push( tube( [ V( 0.0, 0.02, s * 0.36 ), V( 0.3, - 0.02, s * 0.43 ), V( 0.6, - 0.04, s * 0.34 ) ], ( t ) => 0.13 * ( 1 - Math.abs( t - 0.4 ) ), 8, 8 ) );

		// coroa: dois chifres principais, dois secundários, dois terciários
		headHorn.push( spike( V( 0.16, 0.3, s * 0.24 ), V( - 0.75, 0.74, s * 0.46 ), V( - 1.7, 0.62, s * 0.36 ), 0.125, 18, 9 ) );
		headHorn.push( spike( V( 0.08, 0.14, s * 0.37 ), V( - 0.5, 0.3, s * 0.62 ), V( - 1.1, 0.14, s * 0.62 ), 0.09, 14, 8 ) );
		headHorn.push( spike( V( 0.04, - 0.06, s * 0.36 ), V( - 0.32, - 0.08, s * 0.56 ), V( - 0.72, - 0.2, s * 0.56 ), 0.07, 12, 7 ) );
		// espinhos da sobrancelha
		for ( let i = 0; i < 4; i ++ ) headHorn.push( straight( V( 0.3 + i * 0.13, 0.44 - i * 0.03, s * ( 0.3 - i * 0.02 ) ), V( 0.16 + i * 0.12, 0.66 - i * 0.07, s * ( 0.42 - i * 0.03 ) ), 0.045 - i * 0.005 ) );
		// espinhos da bochecha e do queixo
		for ( let i = 0; i < 4; i ++ ) headHorn.push( straight( V( 0.1 + i * 0.16, - 0.1, s * ( 0.4 - i * 0.02 ) ), V( - 0.1 + i * 0.15, - 0.26 - i * 0.01, s * ( 0.58 - i * 0.04 ) ), 0.045 ) );

	}

	// crista central de espinhos sobre o crânio e chifre nasal
	for ( let i = 0; i < 6; i ++ ) headHorn.push( straight( V( 0.42 - i * 0.11, 0.44 - i * 0.03, 0 ), V( 0.24 - i * 0.13, 0.7 - i * 0.05, 0 ), 0.055 - i * 0.004 ) );
	headHorn.push( straight( V( 1.62, 0.2, 0 ), V( 1.5, 0.36, 0 ), 0.05 ) );

	mesh( headSkin, headMat, head );
	mesh( headHorn, hornMat, head );

	// olhos
	for ( const s of [ - 1, 1 ] ) {

		const eye = new THREE.Mesh( new THREE.SphereGeometry( 0.062, 16, 12 ), eyeMat );
		eye.position.set( 0.6, 0.27, s * 0.31 );
		eye.rotation.set( - 0.25 * s, ( s > 0 ? 0 : Math.PI ) + 0.35 * s, 0 );
		eye.scale.set( 1.25, 0.8, 0.55 );
		head.add( eye );

	}

	// dentes superiores: fileira irregular com presas na frente
	const fang = ( i ) => 0.07 + 0.08 * Math.abs( Math.sin( i * 1.9 ) ) + ( i === 9 || i === 6 ? 0.1 : 0 );
	const teethU = [];
	for ( const s of [ - 1, 1 ] ) for ( let i = 0; i < 12; i ++ ) {

		const x = 0.6 + i * 0.105;
		const [ , w, , bot ] = interp( skullS, x );
		teethU.push( straight( V( x, bot + 0.02, s * w * 0.86 ), V( x + 0.03, bot - fang( i ), s * w * 0.9 ), 0.03, 5, 6 ) );

	}

	for ( const z of [ - 0.06, 0.06 ] ) teethU.push( straight( V( 1.84, - 0.03, z ), V( 1.87, - 0.15, z ), 0.025, 5, 6 ) );
	mesh( teethU, toothMat, head, false );

	// mandíbula (gira em torno do eixo z na articulação)
	const jaw = new THREE.Group();
	jaw.position.set( 0.14, - 0.15, 0 );
	head.add( jaw );

	const jawS = [
		[ - 0.12, 0.3, 0.0, - 0.2 ], [ 0.15, 0.39, 0.0, - 0.26 ], [ 0.42, 0.34, - 0.01, - 0.22 ], [ 0.75, 0.25, - 0.015, - 0.15 ],
		[ 1.1, 0.205, - 0.02, - 0.115 ], [ 1.4, 0.18, - 0.02, - 0.105 ], [ 1.58, 0.14, - 0.02, - 0.1 ], [ 1.68, 0.06, - 0.03, - 0.06 ]
	];
	mesh( loft( jawS ), headMat, jaw );

	const teethL = [];
	for ( const s of [ - 1, 1 ] ) for ( let i = 0; i < 11; i ++ ) {

		const x = 0.48 + i * 0.105;
		const [ , w ] = interp( jawS, x );
		teethL.push( straight( V( x, - 0.03, s * w * 0.82 ), V( x + 0.02, 0.05 + fang( i + 3 ) * 0.8, s * w * 0.86 ), 0.027, 5, 6 ) );

	}

	mesh( teethL, toothMat, jaw, false );

	// espinhos do queixo
	const chin = [];
	for ( let i = 0; i < 5; i ++ ) chin.push( straight( V( 1.45 - i * 0.24, - 0.11 - i * 0.02, 0 ), V( 1.28 - i * 0.25, - 0.3 - i * 0.03, 0 ), 0.045 ) );
	mesh( chin, hornMat, jaw );

	// língua
	mesh( tube( [ V( 0.25, - 0.03, 0 ), V( 0.7, 0.0, 0 ), V( 1.1, 0.02, 0 ), V( 1.42, 0.07, 0 ) ], ( t ) => [ 0.13 * ( 1 - t * 0.8 ), 0.035 * ( 1 - t * 0.5 ) ], 12, 10 ), tongueMat, jaw, false );

	// garganta em brasa
	const gullet = new THREE.Mesh( new THREE.SphereGeometry( 1, 14, 10 ), mouthMat );
	gullet.position.set( 0.5, - 0.13, 0 );
	gullet.scale.set( 0.5, 0.1, 0.24 );
	head.add( gullet );

	// ---- pernas traseiras (digitígradas) ---------------------------------

	const legSkin = [], claws = [];

	for ( const s of [ - 1, 1 ] ) {

		const hip = V( - 11.4, 2.35, s * 0.95 ), knee = V( - 10.1, 1.35, s * 1.62 );
		const ankle = V( - 11.3, 0.8, s * 1.7 ), foot = V( - 10.6, 0.18, s * 1.75 );

		legSkin.push( blob( V( - 11.45, 2.3, s * 0.95 ), 1.0, V( 1.2, 1.05, 0.66 ) ) ); // anca
		legSkin.push( tube( [ hip, hip.clone().lerp( knee, 0.5 ).add( V( 0.12, 0.1, s * 0.08 ) ), knee ], ( t ) => [ 0.64 - t * 0.28, 0.92 - t * 0.46 ], 14, 12 ) ); // coxa
		legSkin.push( tube( [ knee, knee.clone().lerp( ankle, 0.45 ).add( V( - 0.14, 0.02, 0 ) ), ankle ], ( t ) => [ 0.32 - t * 0.11, 0.46 - 0.22 * t + 0.12 * Math.sin( t * Math.PI ) ], 12, 10 ) ); // canela
		legSkin.push( tube( [ ankle, ankle.clone().lerp( foot, 0.5 ).add( V( 0.06, 0.04, 0 ) ), foot ], ( t ) => 0.23 - t * 0.04, 10, 9 ) ); // metatarso
		legSkin.push( blob( foot, 0.25, V( 1.3, 0.7, 1.2 ) ) );
		claws.push( straight( knee.clone().add( V( 0.28, 0.1, 0 ) ), knee.clone().add( V( 0.62, 0.34, 0 ) ), 0.08 ) ); // espinho do joelho

		// três dedos à frente e um atrás, com garras
		for ( const [ ang, len ] of [ [ - 0.5, 0.82 ], [ 0, 0.95 ], [ 0.5, 0.82 ], [ Math.PI, 0.5 ] ] ) {

			const d = V( Math.cos( ang ), 0, Math.sin( ang ) * s );
			const tip = foot.clone().addScaledVector( d, len ); tip.y = 0.09;
			const mid = foot.clone().addScaledVector( d, len * 0.5 ); mid.y = 0.2;
			legSkin.push( tube( [ foot, mid, tip ], ( t ) => 0.135 - t * 0.045, 8, 8 ) );
			const c1 = tip.clone().addScaledVector( d, 0.2 ); c1.y = 0.17;
			const c2 = tip.clone().addScaledVector( d, 0.42 ); c2.y = 0.0;
			claws.push( spike( tip.clone().add( V( 0, 0.03, 0 ) ), c1, c2, 0.09, 8, 7 ) );

		}

	}

	mesh( legSkin, limbMat );
	mesh( claws, hornMat );

	// ---- asas -----------------------------------------------------------

	function buildWing( s ) {

		const group = new THREE.Group();
		const S = V( - 9.05, 3.4, s * 0.8 );
		group.position.copy( S );

		// pontos relativos ao ombro
		const E = V( - 1.7, 2.5, s * 2.0 );
		const W = V( 0.6, 5.0, s * 3.7 );
		const F = [
			W.clone().add( V( 1.5, 0.9, s * 0.7 ) ), // garra do polegar
			W.clone().add( V( 0.6, 3.9, s * 3.4 ) ),
			W.clone().add( V( - 2.7, 2.9, s * 5.0 ) ),
			W.clone().add( V( - 5.4, - 0.1, s * 4.6 ) ),
			W.clone().add( V( - 6.2, - 3.9, s * 1.9 ) )
		];
		const A = V( - 3.3, - 1.1, s * 0.1 ); // prende no quadril

		const bones = [], horn = [];
		bones.push( blob( V( - 0.1, 0.0, - s * 0.12 ), 0.6, V( 1.35, 1.1, 0.5 ) ) ); // ombro
		bones.push( tube( [ V( 0, 0, 0 ), E.clone().multiplyScalar( 0.5 ).add( V( 0, 0.2, 0 ) ), E ], ( t ) => [ 0.3 - t * 0.12, 0.42 - t * 0.2 ], 12, 10 ) ); // braço
		bones.push( blob( E, 0.24, V( 1, 1, 1 ) ) );
		bones.push( tube( [ E, E.clone().lerp( W, 0.5 ).add( V( - 0.15, 0, 0 ) ), W ], ( t ) => 0.2 - t * 0.07 + 0.04 * Math.sin( t * Math.PI ), 12, 9 ) ); // antebraço
		bones.push( blob( W, 0.2, V( 1.1, 1, 1 ) ) );

		for ( let i = 1; i < F.length; i ++ ) {

			const mid = W.clone().lerp( F[ i ], 0.5 ).add( V( 0, 0.3, 0 ) );
			bones.push( tube( [ W, mid, F[ i ] ], ( t ) => 0.085 * ( 1 - t * 0.8 ) + 0.012, 18, 7 ) );
			// juntas dos dedos
			const curve = new THREE.CatmullRomCurve3( [ W, mid, F[ i ] ] );
			for ( const k of [ 0.36, 0.7 ] ) bones.push( blob( curve.getPoint( k ), 0.085 * ( 1 - k * 0.6 ) + 0.02, V( 1, 1, 1 ) ) );
			// garra na ponta de cada dedo
			const dir = F[ i ].clone().sub( mid ).normalize();
			horn.push( spike( F[ i ], F[ i ].clone().addScaledVector( dir, 0.25 ).add( V( 0, - 0.06, 0 ) ), F[ i ].clone().addScaledVector( dir, 0.45 ).add( V( 0, - 0.26, 0 ) ), 0.05, 8, 6 ) );

		}

		bones.push( tube( [ W, W.clone().lerp( F[ 0 ], 0.6 ), F[ 0 ] ], ( t ) => 0.1 * ( 1 - t * 0.6 ) + 0.01, 8, 7 ) );
		horn.push( spike( F[ 0 ], F[ 0 ].clone().add( V( 0.4, 0.05, s * 0.05 ) ), F[ 0 ].clone().add( V( 0.62, - 0.36, s * 0.05 ) ), 0.1, 10, 8 ) ); // garra do polegar

		mesh( bones, limbMat, group );
		mesh( horn, hornMat, group );

		// membrana: painéis em leque com a borda de fuga recortada
		const pos = [], uvs = [], idx = [];
		const panel = ( apex, a, b, scallop, u0, u1 ) => {

			const N = 16, M = 10;
			const base = pos.length / 3;
			const mid = a.clone().lerp( b, 0.5 );

			for ( let i = 0; i <= N; i ++ ) {

				const sT = i / N;
				const edge = a.clone().lerp( b, sT );
				edge.add( apex.clone().sub( mid ).multiplyScalar( scallop * Math.sin( Math.PI * sT ) ) );

				for ( let j = 0; j <= M; j ++ ) {

					const p = apex.clone().lerp( edge, j / M );
					// a membrana embarriga entre os dedos
					p.x -= Math.sin( Math.PI * sT ) * Math.sin( Math.PI * j / M ) * 0.3;
					pos.push( p.x, p.y, p.z );
					uvs.push( u0 + ( u1 - u0 ) * sT, j / M );
					if ( i < N && j < M ) {

						const k = base + i * ( M + 1 ) + j;
						idx.push( k, k + M + 1, k + 1, k + 1, k + M + 1, k + M + 2 );

					}

				}

			}

		};

		panel( W, F[ 1 ], F[ 2 ], 0.34, 0.0, 0.2 );
		panel( W, F[ 2 ], F[ 3 ], 0.34, 0.2, 0.4 );
		panel( W, F[ 3 ], F[ 4 ], 0.34, 0.4, 0.6 );
		panel( W, F[ 4 ], A, 0.26, 0.6, 0.8 );
		panel( A, W, E, 0.0, 0.8, 0.9 );
		panel( A, E, V( 0, 0, 0 ), 0.0, 0.9, 1.0 );

		const mGeo = new THREE.BufferGeometry();
		mGeo.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
		mGeo.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
		mGeo.setIndex( idx );
		mGeo.computeVertexNormals();
		mesh( mGeo, wingMat, group );

		root.add( group );
		return group;

	}

	const wingR = buildWing( 1 );
	const wingL = buildWing( - 1 );

	// ---- animação -------------------------------------------------------

	const mouthPosition = MOUTH_POS.clone();
	const jetDirection = JET_DIR.clone();
	const _m = new THREE.Matrix4();
	let recoil = 0;

	function update( dt, time, fire ) {

		uFire.value = fire;
		recoil += ( fire - recoil ) * Math.min( 1, dt * 3 );
		breath = 0.03 * Math.sin( time * 1.3 ) + 0.03 * fire;

		// a cabeça treme e balança de leve; o jato segue a cabeça
		const shake = fire * 0.012;
		jetDirection.copy( JET_DIR );
		jetDirection.y += Math.sin( time * 0.7 ) * 0.012 + Math.sin( time * 23.0 ) * shake;
		jetDirection.z += Math.sin( time * 0.53 + 1.0 ) * 0.02 + Math.sin( time * 19.0 + 2.0 ) * shake;
		jetDirection.normalize();

		headDir.copy( jetDirection );
		headSide.set( 0, 0, 1 ).addScaledVector( headDir, - headDir.z ).normalize();
		headUp.crossVectors( headSide, headDir ).normalize();

		// boca fixa no mundo (com um respiro); a base da cabeça recua a partir dela
		mouthPosition.copy( MOUTH_POS );
		mouthPosition.y += Math.sin( time * 0.9 ) * 0.03;
		mouthPosition.addScaledVector( headDir, - recoil * 0.12 );
		headBase.copy( mouthPosition )
			.addScaledVector( headDir, - HEAD_MOUTH.x )
			.addScaledVector( headUp, - HEAD_MOUTH.y );

		_m.makeBasis( headDir, headUp, headSide );
		head.quaternion.setFromRotationMatrix( _m );
		head.position.copy( headBase );
		jaw.rotation.z = - ( 0.12 + 0.52 * Math.min( 1, fire * 1.6 ) + Math.sin( time * 17 ) * 0.012 * fire );

		// espinha: a cauda ondula, o pescoço acompanha a cabeça
		for ( let i = 0; i < spine.length - 1; i ++ ) {

			const r = spineRest[ i ];
			const tail = Math.max( 0, 1 - i / 4.5 );
			const neck = Math.max( 0, ( i - 7 ) / 4 );
			spine[ i ].set(
				r.x - neck * recoil * 0.1,
				r.y + neck * Math.sin( time * 0.9 - i * 0.5 ) * 0.05 + tail * Math.sin( time * 0.8 + i ) * 0.05,
				r.z + tail * Math.sin( time * 0.6 + i * 0.9 ) * 0.5 + neck * Math.sin( time * 0.53 + 1.0 ) * 0.06
			);

		}

		spine[ spine.length - 1 ].copy( headBase ).addScaledVector( headDir, 0.04 );
		spine[ spine.length - 2 ].copy( headBase ).addScaledVector( headDir, - 0.78 ).addScaledVector( headUp, 0.24 );

		spineCurve.needsUpdate = true;
		const N = spineSamples.length;
		for ( let i = 0; i < N; i ++ ) spineCurve.getPointAt( i / ( N - 1 ), spineSamples[ i ] );
		writeTube( bodyGeo, spineSamples, bodyRadius, RINGS, SEGS );

		// espinhos ao longo do dorso: maiores nos ombros, pequenos na cauda e na nuca
		for ( let i = 0; i < SPIKES; i ++ ) {

			const t = 0.06 + ( i / ( SPIKES - 1 ) ) * 0.91;
			const f = t * ( N - 1 );
			const i0 = Math.min( N - 2, Math.floor( f ) );
			_p.lerpVectors( spineSamples[ i0 ], spineSamples[ i0 + 1 ], f - i0 );
			_t.subVectors( spineSamples[ Math.min( N - 1, i0 + 2 ) ], spineSamples[ Math.max( 0, i0 - 1 ) ] ).normalize();
			_b.crossVectors( _t, _up ).normalize();
			_n.crossVectors( _b, _t ).normalize();
			const r = radiusAt( t );
			const size = ( 0.14 + 0.46 * r ) * ( 0.78 + 0.22 * Math.sin( i * 2.4 ) );
			dummy.position.copy( _p ).addScaledVector( _n, r * 1.08 );
			_v.copy( _n ).addScaledVector( _t, - 0.6 ).normalize();
			dummy.quaternion.setFromUnitVectors( _up, _v );
			dummy.scale.set( size * 0.4, size * 1.35, size * 0.18 );
			dummy.updateMatrix();
			spikes.setMatrixAt( i, dummy.matrix );

		}

		spikes.instanceMatrix.needsUpdate = true;

		// asas: respiram devagar e abrem quando ele cospe
		const flap = Math.sin( time * 0.8 ) * 0.035 + recoil * 0.13;
		wingR.rotation.set( flap, - recoil * 0.06, 0 );
		wingL.rotation.set( - flap, recoil * 0.06, 0 );

	}

	update( 0.016, 0, 0 );

	return { root, mouthPosition, jetDirection, update };

}
