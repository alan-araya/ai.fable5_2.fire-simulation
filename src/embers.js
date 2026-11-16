import * as THREE from 'three/webgpu';
import {
	Fn, If, vec2, vec3, vec4, float, uint, uniform, instancedArray, instanceIndex, hash, texture, texture3D, uv,
	smoothstep, mix, max, min, clamp
} from 'three/tsl';

import { BOX_MIN, BOX_SIZE, MOUTH_POS, JET_DIR, ROCK_CENTER, ROCK_RADIUS, LUT_TMAX } from './config.js';
import { createBlackbodyLUT } from './lut.js';

// ---------------------------------------------------------------
// Brasas: partículas na GPU carregadas pelo próprio campo de velocidade
// da simulação (arrasto + empuxo + gravidade), então elas seguem os
// redemoinhos do fogo de verdade.
// ---------------------------------------------------------------

export function createEmbers( scene, sim, quality, noiseTexture ) {

	const COUNT = quality.embers;

	const positions = instancedArray( COUNT, 'vec4' ); // xyz, vida restante
	const velocities = instancedArray( COUNT, 'vec4' ); // xyz, vida total

	const u = {
		dt: uniform( 1 / 60 ),
		seed: uniform( 0 ),
		fire: uniform( 0 ),
		impact: uniform( 0 ),
		glow: uniform( 0 ),
		mouth: uniform( MOUTH_POS.clone() ),
		jetDir: uniform( JET_DIR.clone() ),
		rockCenter: uniform( ROCK_CENTER.clone() ),
		rockRadius: uniform( ROCK_RADIUS ),
		jetSpeed: sim.uniforms.jetSpeed
	};

	const SIZE = vec3( BOX_SIZE.x, BOX_SIZE.y, BOX_SIZE.z );
	const BMIN = vec3( BOX_MIN.x, BOX_MIN.y, BOX_MIN.z );

	const rnd = ( k ) => hash( instanceIndex.add( uint( k ) ).add( uint( u.seed ) ) );
	const rndDir = ( k ) => vec3( rnd( k ), rnd( k + 1 ), rnd( k + 2 ) ).sub( 0.5 ).mul( 2.0 );

	const init = Fn( () => {

		positions.element( instanceIndex ).assign( vec4( 0, - 100, 0, 0 ) );
		velocities.element( instanceIndex ).assign( vec4( 0, 0, 0, 1 ) );

	} )().compute( COUNT ).setName( 'embersInit' );

	const update = Fn( () => {

		const P = positions.element( instanceIndex );
		const V = velocities.element( instanceIndex );

		const pos = P.xyz.toVar();
		const vel = V.xyz.toVar();
		const life = P.w.sub( u.dt ).toVar();
		const total = V.w.toVar();

		If( life.lessThanEqual( 0.0 ), () => {

			// morta: renasce no impacto, no jato ou na pedra incandescente
			const pick = rnd( 11 );
			const wImpact = u.impact.mul( 0.55 );
			const wJet = u.fire.mul( 0.3 );
			const wGlow = u.glow.mul( 0.12 );
			const chance = wImpact.add( wJet ).add( wGlow ).mul( u.dt ).mul( 1.1 );

			If( rnd( 12 ).lessThan( chance ), () => {

				const sel = pick.mul( wImpact.add( wJet ).add( wGlow ) );

				If( sel.lessThan( wImpact ), () => {

					// faíscas arrancadas da pedra no ponto de impacto
					const d = rndDir( 20 ).sub( u.jetDir.mul( 1.2 ) ).normalize();
					pos.assign( u.rockCenter.add( d.mul( u.rockRadius.mul( 0.95 ) ) ) );
					vel.assign( d.mul( rnd( 24 ).mul( 9.0 ).add( 2.0 ) ).add( vec3( 0, rnd( 25 ).mul( 5.0 ), 0 ) ).add( u.jetDir.mul( 4.0 ) ) );
					total.assign( rnd( 26 ).mul( 1.6 ).add( 0.5 ) );

				} ).ElseIf( sel.lessThan( wImpact.add( wJet ) ), () => {

					// fagulhas dentro do jato
					const along = rnd( 30 ).mul( 5.0 );
					pos.assign( u.mouth.add( u.jetDir.mul( along ) ).add( rndDir( 31 ).mul( along.mul( 0.12 ).add( 0.15 ) ) ) );
					vel.assign( u.jetDir.mul( u.jetSpeed.mul( rnd( 34 ).mul( 0.5 ).add( 0.35 ) ) ).add( rndDir( 35 ).mul( 3.0 ) ) );
					total.assign( rnd( 38 ).mul( 0.9 ).add( 0.35 ) );

				} ).Else( () => {

					// brasas subindo da pedra / lava
					const d = rndDir( 40 ).normalize();
					pos.assign( u.rockCenter.add( d.mul( u.rockRadius.mul( 0.8 ) ).mul( vec3( 1, 0.5, 1 ) ) ) );
					vel.assign( vec3( d.x, rnd( 43 ).mul( 2.0 ).add( 0.6 ), d.z ) );
					total.assign( rnd( 44 ).mul( 2.4 ).add( 1.0 ) );

				} );

				life.assign( total );

			} ).Else( () => {

				pos.assign( vec3( 0, - 100, 0 ) );
				life.assign( 0.0 );

			} );

		} ).Else( () => {

			// viva: arrastada pelo gás da simulação
			const uvw = pos.sub( BMIN ).div( SIZE );
			const inside = uvw.x.greaterThan( 0.0 ).and( uvw.x.lessThan( 1.0 ) )
				.and( uvw.y.greaterThan( 0.0 ) ).and( uvw.y.lessThan( 1.0 ) )
				.and( uvw.z.greaterThan( 0.0 ) ).and( uvw.z.lessThan( 1.0 ) );
			const gas = sim.velNode.sample( uvw.clamp( 0.0, 1.0 ) ).level( 0 ).xyz.mul( inside.select( float( 1 ), float( 0 ) ) );

			const flutter = texture3D( noiseTexture, pos.mul( 0.7 ).add( rnd( 50 ) ), 0 ).xyz.sub( 0.5 ).mul( 9.0 );
			vel.addAssign( gas.sub( vel ).mul( min( float( 1.0 ), u.dt.mul( 3.2 ) ) ) );
			vel.addAssign( flutter.add( vec3( 0, - 2.6, 0 ) ).mul( u.dt ) );
			pos.addAssign( vel.mul( u.dt ) );

			// quica no chão e perde energia
			If( pos.y.lessThan( 0.03 ), () => {

				pos.assign( vec3( pos.x, 0.03, pos.z ) );
				vel.assign( vec3( vel.x.mul( 0.5 ), vel.y.abs().mul( 0.3 ), vel.z.mul( 0.5 ) ) );

			} );

		} );

		P.assign( vec4( pos, life ) );
		V.assign( vec4( vel, total ) );

	} )().compute( COUNT ).setName( 'embersUpdate' );

	// ---- render ---------------------------------------------------------

	const lutTex = createBlackbodyLUT( 64 );
	const material = new THREE.SpriteNodeMaterial();
	material.transparent = true;
	material.blending = THREE.AdditiveBlending;
	material.depthWrite = false;
	material.fog = false;

	const pAttr = positions.toAttribute();
	const vAttr = velocities.toAttribute();
	const lifeFrac = clamp( pAttr.w.div( max( vAttr.w, 0.001 ) ), 0.0, 1.0 );
	const sizeRnd = hash( instanceIndex.add( uint( 7 ) ) );

	material.positionNode = pAttr.xyz;
	material.scaleNode = sizeRnd.mul( sizeRnd ).mul( 0.034 ).add( 0.011 ).mul( smoothstep( 0.0, 0.25, lifeFrac ) );

	const temp = lifeFrac.mul( 0.75 ).add( 0.55 );
	const core = smoothstep( 0.5, 0.0, uv().sub( 0.5 ).length() );
	material.colorNode = texture( lutTex, vec2( temp.div( LUT_TMAX ), 0.5 ) ).rgb.mul( 4.0 ).mul( core.mul( core ) );
	material.opacityNode = core;

	const sprites = new THREE.Sprite( material );
	sprites.count = COUNT;
	sprites.frustumCulled = false;
	scene.add( sprites );

	let initialized = false;

	return {
		sprites,
		update( dt, time, fire, impact, mouth, jetDir, rockState ) {

			if ( ! initialized ) {

				sim.renderer.compute( init );
				initialized = true;

			}

			u.dt.value = dt;
			u.seed.value = ( u.seed.value + 7919 ) % 1000003;
			u.fire.value = fire;
			u.impact.value = rockState.done ? 0 : impact;
			u.glow.value = Math.min( 1.5, rockState.glow * 2.0 );
			u.mouth.value.copy( mouth );
			u.jetDir.value.copy( jetDir );
			u.rockCenter.value.copy( rockState.obstacleCenter );
			u.rockRadius.value = rockState.done ? 1.4 : Math.max( 0.25, rockState.obstacleRadius.x );
			sim.renderer.compute( update );

		}
	};

}
