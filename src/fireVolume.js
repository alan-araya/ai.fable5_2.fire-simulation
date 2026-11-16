import * as THREE from 'three/webgpu';
import {
	Break, Fn, If, Loop, clamp, computeKernel, dot, exp, float, fract, globalId, ivec2, max, min, mix, normalize,
	perspectiveDepthToViewZ, smoothstep, texture, texture3D, textureLoad, textureStore, uniform, uvec2, vec2, vec3, vec4
} from 'three/tsl';

import { BOX_MIN, BOX_SIZE, LUT_TMAX } from './config.js';

// ---------------------------------------------------------------
// Raymarch do gás em compute, numa textura HDR de resolução reduzida.
//   rgb = luz recolhida ao longo do raio · a = quanto do fundo sobra
//
//  - a chama tem corpo: emissão e absorção andam juntas, então fogo espesso
//    satura na cor da sua temperatura e mostra o relevo da camada de fora
//  - fumaça: luz do fogo (volumes pré-difundidos) + luar com sombra
//    pré-computada + sombreamento pelo gradiente de densidade (as dobras)
//  - o raio para na profundidade da cena do frame anterior (dragão, pedra, chão)
//  - filtro temporal com histórico limitado à vizinhança 3x3: tira o ruído do
//    passo aleatório sem borrar nem deixar fantasmas
// ---------------------------------------------------------------

export function createVolumeUniforms( moonDir ) {

	return {
		thickness: uniform( 0.9 ),
		edge: uniform( 0.35 ),
		flameBody: uniform( 4.5 ),
		emitGain: uniform( 2.2 ),
		frontBoost: uniform( 0.12 ),
		smokeAlbedo: uniform( 0.34 ),
		relief: uniform( 0.7 ),
		fireOnSmoke: uniform( 2.0 ),
		farOnSmoke: uniform( 1.5 ),
		moonOnSmoke: uniform( 0.5 ),
		holdHue: uniform( 0.2 ),
		history: uniform( 0.55 ),
		moonDir: uniform( moonDir.clone().normalize() )
	};

}

export function volumeTunables( p ) {

	return [
		[ p.emitGain, 'brilho da chama', 0, 10 ], [ p.flameBody, 'corpo da chama', 0, 12 ], [ p.frontBoost, 'frente de chama', 0, 1 ],
		[ p.thickness, 'espessura da fumaça', 0, 4 ], [ p.edge, 'borda da fumaça', 0.02, 2 ], [ p.smokeAlbedo, 'claridade da fumaça', 0, 1 ],
		[ p.relief, 'relevo das dobras', 0, 1 ], [ p.fireOnSmoke, 'fogo na fumaça (perto)', 0, 6 ], [ p.farOnSmoke, 'fogo na fumaça (longe)', 0, 6 ],
		[ p.moonOnSmoke, 'luar na fumaça', 0, 3 ], [ p.holdHue, 'teto de brilho', 0, 1 ], [ p.history, 'filtro temporal', 0, 0.9 ]
	];

}

export function makeVolume( renderer, sim, lutTexture, quality, p, width, height, depthTexture, fullWidth, fullHeight ) {

	const target = () => {

		const t = new THREE.StorageTexture( width, height );
		t.type = THREE.HalfFloatType;
		t.format = THREE.RGBAFormat;
		t.minFilter = t.magFilter = THREE.LinearFilter;
		t.generateMipmaps = false;
		return t;

	};

	const raw = target(), output = target(), history = target();

	const invVP = uniform( new THREE.Matrix4() );
	const eye = uniform( new THREE.Vector3() );
	const forward = uniform( new THREE.Vector3() );
	const camNear = uniform( 0.1 );
	const camFar = uniform( 900 );
	const frame = uniform( 0 );

	const lo = vec3( BOX_MIN.x, BOX_MIN.y, BOX_MIN.z );
	const size = vec3( BOX_SIZE.x, BOX_SIZE.y, BOX_SIZE.z );
	const hi = lo.add( size );

	const gas = sim.gasTex;
	const fireColor = ( T ) => texture( lutTexture, vec2( T.div( LUT_TMAX ), 0.5 ) ).level( 0 ).rgb;
	const smokeDensity = ( s ) => s.x.mul( 1.9 );
	const softLight = ( c ) => c.div( c.x.mul( 1.6 ).add( 1 ) );
	const moonColor = vec3( 0.42, 0.52, 0.8 );

	const march = Fn( () => {

		const uv = vec2( globalId.xy ).add( 0.5 ).div( vec2( width, height ) );
		const farP = invVP.mul( vec4( uv.x.mul( 2 ).sub( 1 ), uv.y.mul( 2 ).sub( 1 ).negate(), 1, 1 ) );
		const rd = normalize( farP.xyz.div( farP.w ).sub( eye ) ).toVar();
		const inv = vec3( 1 ).div( rd.add( vec3( 0.00001 ) ) );
		const t0 = lo.sub( eye ).mul( inv ).toVar();
		const t1 = hi.sub( eye ).mul( inv ).toVar();
		const a = min( t0, t1 ), b = max( t0, t1 );
		const tNear = max( max( max( a.x, a.y ), a.z ), 0 ).toVar();

		// geometria da cena à frente do gás
		const depth = textureLoad( depthTexture, ivec2( uv.mul( vec2( fullWidth, fullHeight ) ) ) ).x;
		const viewZ = perspectiveDepthToViewZ( depth, camNear, camFar );
		const tScene = viewZ.negate().div( max( dot( rd, forward ), 0.001 ) );
		const tFar = min( min( min( b.x, b.y ), b.z ), tScene ).toVar();

		const color = vec3( 0 ).toVar();
		const trans = float( 1 ).toVar();

		If( tFar.greaterThan( tNear ), () => {

			const dl = tFar.sub( tNear ).div( quality.steps ).toVar();
			// ruído de gradiente intercalado: troca as faixas por ruído, que o filtro temporal média
			const ign = fract( dot( vec2( globalId.xy ), vec2( 0.06711056, 0.00583715 ) ).mul( 52.9829189 ).add( frame.mul( 0.61803 ) ) ).toVar();
			const t = tNear.add( dl.mul( ign ) ).toVar();

			Loop( quality.steps, () => {

				const pos = eye.add( rd.mul( t ) ).toVar();
				const uvw = pos.sub( lo ).div( size ).toVar();

				// salto de vazio: a máscara de ocupação (textura minúscula, sempre em cache)
				// diz se vale a pena tocar na textura de gás
				If( texture3D( sim.lightFarTex, uvw ).level( 0 ).a.greaterThan( 0.02 ), () => {

				const s = texture3D( gas, uvw ).level( 0 ).toVar();
				const smoke = smokeDensity( s ).toVar();

				// névoa fina some e gás grosso vira corpo sólido com borda; a chama também é opaca
				const sigma = smoke.mul( smoke ).div( smoke.add( p.edge ) ).mul( p.thickness )
					.add( smoothstep( 0.12, 0.34, s.y ).mul( s.y ).mul( p.flameBody ) ).toVar();

				If( sigma.greaterThan( 0.01 ), () => {

					const close = softLight( texture3D( sim.lightTex, uvw ).level( 0 ).xyz ).toVar();
					const fire = close.mul( p.fireOnSmoke ).add( texture3D( sim.lightFarTex, uvw ).level( 0 ).xyz.mul( p.farOnSmoke ) );

					// o luar apaga onde o fogo manda, para laranja e azul não somarem em lilás
					const calm = smoothstep( 0, 0.4, s.y ).oneMinus().mul( close.x.mul( 1.1 ).oneMinus().max( 0 ) );
					const moon = moonColor.mul( texture3D( sim.moonTex, uvw ).level( 0 ).x ).mul( p.moonOnSmoke );

					// sombreamento pelo gradiente de densidade: esculpe as dobras que a sombra grossa não mostra
					const rho = ( o ) => smokeDensity( texture3D( gas, uvw.add( o ) ).level( 0 ) );
					const e = 0.008;
					const slope = vec3( rho( vec3( e / 2, 0, 0 ) ), rho( vec3( 0, e, 0 ) ), rho( vec3( 0, 0, e ) ) ).sub( smoke ).negate();
					const nrm = normalize( slope.add( vec3( 0.0001 ) ) ).toVar();
					const facing = dot( nrm, p.moonDir ).mul( 0.5 ).add( 0.5 );
					const folds = dot( nrm, rd.negate() ).max( 0 ).mul( 0.35 ).add( facing.mul( 0.65 ) ).mul( p.relief ).add( p.relief.oneMinus() );

					const ambient = vec3( 0.006, 0.008, 0.014 );
					const lit = fire.add( moon.mul( calm ) ).mul( folds ).add( ambient ).mul( p.smokeAlbedo );
					const emission = fireColor( s.y ).mul( p.emitGain ).mul( s.w.mul( p.frontBoost ).add( 1.0 ) );

					const seg = exp( sigma.mul( dl ).negate() ).toVar();
					color.addAssign( lit.add( emission ).mul( seg.oneMinus() ).mul( trans ) );
					trans.mulAssign( seg );

				} );

				} );

				If( trans.lessThan( 0.01 ), () => {

					Break();

				} );

				t.addAssign( dl );

			} );

		} );

		// comprime a luz forte ao longo da própria cor: o fogo espesso fica laranja em vez de creme
		const held = color.div( max( max( color.x, color.y ), color.z ).mul( p.holdHue ).add( 1 ) );
		textureStore( raw, uvec2( globalId.xy ), vec4( held, trans ) ).toWriteOnly();

	} );

	const kernel = computeKernel( march(), [ 8, 8 ] );
	kernel.setName( 'raymarch' );

	const size2 = ivec2( width - 1, height - 1 );

	const resolveFn = Fn( () => {

		const c = ivec2( globalId.xy ).toVar();
		const cur = textureLoad( raw, c ).toVar();
		const mn = cur.toVar(), mx = cur.toVar();

		for ( const [ x, y ] of [ [ - 1, - 1 ], [ 0, - 1 ], [ 1, - 1 ], [ - 1, 0 ], [ 1, 0 ], [ - 1, 1 ], [ 0, 1 ], [ 1, 1 ] ] ) {

			const n = textureLoad( raw, clamp( c.add( ivec2( x, y ) ), ivec2( 0 ), size2 ) ).toVar();
			mn.assign( min( mn, n ) );
			mx.assign( max( mx, n ) );

		}

		textureStore( output, uvec2( globalId.xy ), mix( cur, clamp( textureLoad( history, c ), mn, mx ), p.history ) ).toWriteOnly();

	} );

	const copyFn = Fn( () => {

		textureStore( history, uvec2( globalId.xy ), textureLoad( output, ivec2( globalId.xy ) ) ).toWriteOnly();

	} );

	const dispatch = [ Math.ceil( width / 8 ), Math.ceil( height / 8 ), 1 ];
	const resolve = computeKernel( resolveFn(), [ 8, 8 ] );
	const copy = computeKernel( copyFn(), [ 8, 8 ] );
	resolve.setName( 'volumeResolve' );
	copy.setName( 'volumeCopy' );
	kernel.dispatchSize = resolve.dispatchSize = copy.dispatchSize = dispatch;

	const passes = [ kernel, resolve, copy ];
	const fwd = new THREE.Vector3();

	return {
		texture: output,
		width, height,
		render( camera, n ) {

			camera.updateMatrixWorld();
			invVP.value.copy( camera.matrixWorld ).multiply( camera.projectionMatrixInverse );
			eye.value.setFromMatrixPosition( camera.matrixWorld );
			forward.value.copy( camera.getWorldDirection( fwd ) );
			camNear.value = camera.near;
			camFar.value = camera.far;
			frame.value = n % 64;
			renderer.compute( passes );

		},
		dispose() {

			raw.dispose(); output.dispose(); history.dispose();
			passes.forEach( ( k ) => k.dispose() );

		}
	};

}
