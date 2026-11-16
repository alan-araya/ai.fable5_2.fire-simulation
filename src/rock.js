import * as THREE from 'three/webgpu';
import {
	Fn, vec2, vec3, float, uniform, attribute, texture, texture3D, positionWorld, normalWorld, positionLocal,
	smoothstep, mix, max, min, bumpMap, uv, pow
} from 'three/tsl';

import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

import { ROCK_CENTER, ROCK_RADIUS, MOUTH_POS, LUT_TMAX } from './config.js';
import { SHAPE_W, SHAPE_H, SHAPE_MAX } from './fireSim.js';
import { loadTexture, heightOf } from './environment.js';

// ---------------------------------------------------------------
// A pedra: malha procedural com calor e derretimento por vértice.
//  - o lado atingido pelo jato aquece primeiro; o calor conduz pela malha
//  - acima do ponto de fusão o vértice escorre para a base e a pedra encolhe
//  - a lava forma uma poça incandescente que esfria devagar
// ---------------------------------------------------------------

const MELT_POINT = 0.72;
const DRIPS = 220;

export function triplanar( tex, p, n, scale ) {

	const w = pow( n.abs(), vec3( 4.0 ) );
	const ws = w.div( w.x.add( w.y ).add( w.z ) );
	return texture( tex, p.yz.mul( scale ) ).mul( ws.x )
		.add( texture( tex, p.xz.mul( scale ) ).mul( ws.y ) )
		.add( texture( tex, p.xy.mul( scale ) ).mul( ws.z ) );

}

export function createRock( scene, sim, fireGI, lutTexture, noiseTexture ) {

	const perlin = new ImprovedNoise();
	const base = new THREE.Vector3( ROCK_CENTER.x, 0, ROCK_CENTER.z ); // para onde a lava escorre

	// ---- geometria ------------------------------------------------------

	let geo = new THREE.IcosahedronGeometry( 1, 44 );
	geo.deleteAttribute( 'uv' );
	geo.deleteAttribute( 'normal' );
	geo = mergeVertices( geo, 1e-4 );

	const count = geo.attributes.position.count;
	const dirs = Float32Array.from( geo.attributes.position.array );
	const basePos = new Float32Array( count * 3 );
	const baseNrm = new Float32Array( count * 3 );
	const heat = new Float32Array( count );
	const melt = new Float32Array( count );
	const heatTmp = new Float32Array( count );
	const jitter = new Float32Array( count );

	geo.setAttribute( 'aBase', new THREE.BufferAttribute( basePos, 3 ) );
	geo.setAttribute( 'aBaseNormal', new THREE.BufferAttribute( baseNrm, 3 ) );
	geo.setAttribute( 'aHeat', new THREE.BufferAttribute( heat, 1 ) );
	geo.setAttribute( 'aMelt', new THREE.BufferAttribute( melt, 1 ) );
	geo.attributes.position.setUsage( THREE.DynamicDrawUsage );
	geo.attributes.aHeat.setUsage( THREE.DynamicDrawUsage );
	geo.attributes.aMelt.setUsage( THREE.DynamicDrawUsage );

	// adjacência (CSR) para condução de calor
	const index = geo.index.array;
	const sets = Array.from( { length: count }, () => new Set() );

	for ( let i = 0; i < index.length; i += 3 ) {

		const a = index[ i ], b = index[ i + 1 ], c = index[ i + 2 ];
		sets[ a ].add( b ).add( c ); sets[ b ].add( a ).add( c ); sets[ c ].add( a ).add( b );

	}

	const adjStart = new Uint32Array( count + 1 );
	let total = 0;
	for ( let i = 0; i < count; i ++ ) { adjStart[ i ] = total; total += sets[ i ].size; }
	adjStart[ count ] = total;
	const adj = new Uint32Array( total );
	for ( let i = 0, k = 0; i < count; i ++ ) for ( const n of sets[ i ] ) adj[ k ++ ] = n;

	function buildShape( seed ) {

		const pos = geo.attributes.position.array;
		const fbm = ( x, y, z ) => {

			let v = 0, a = 0.5, f = 1;
			for ( let o = 0; o < 4; o ++ ) { v += a * perlin.noise( x * f + seed, y * f + seed * 0.7, z * f - seed ); a *= 0.5; f *= 2.03; }
			return v;

		};

		for ( let i = 0; i < count; i ++ ) {

			const dx = dirs[ i * 3 ], dy = dirs[ i * 3 + 1 ], dz = dirs[ i * 3 + 2 ];
			const big = fbm( dx * 1.1, dy * 1.1, dz * 1.1 );
			const ridged = 1 - Math.abs( perlin.noise( dx * 3.1 + seed, dy * 3.1, dz * 3.1 ) ) * 2;
			const fine = perlin.noise( dx * 9 + seed, dy * 9, dz * 9 );
			// facetas: quantiza um pouco o raio para dar planos de fratura
			let r = 1 + big * 0.42 + ridged * 0.07 + fine * 0.03;
			r = THREE.MathUtils.clamp( r, 0.72, 1.3 ) * ROCK_RADIUS;

			let x = dx * r, y = dy * r * 0.9, z = dz * r * 0.94;

			// assenta no chão
			const floor = - ROCK_CENTER.y + 0.02;
			if ( y < floor + 0.35 ) y = floor + ( y - floor ) * 0.25 + ( y < floor ? ( floor - y ) * 0.2 : 0 );
			if ( y < floor ) y = floor;

			basePos[ i * 3 ] = pos[ i * 3 ] = ROCK_CENTER.x + x;
			basePos[ i * 3 + 1 ] = pos[ i * 3 + 1 ] = ROCK_CENTER.y + y;
			basePos[ i * 3 + 2 ] = pos[ i * 3 + 2 ] = ROCK_CENTER.z + z;
			jitter[ i ] = 0.75 + 0.5 * ( perlin.noise( dx * 5 - seed, dy * 5, dz * 5 + seed ) * 0.5 + 0.5 );

		}

		geo.attributes.position.needsUpdate = true;
		geo.computeVertexNormals();
		baseNrm.set( geo.attributes.normal.array );
		geo.attributes.aBase.needsUpdate = true;
		geo.attributes.aBaseNormal.needsUpdate = true;
		geo.computeBoundingSphere();
		geo.boundingSphere.radius *= 1.5;

	}

	// ---- material -------------------------------------------------------

	const rockTex = loadTexture( '/textures/rock.png' );
	const uTime = sim.uniforms.time;
	const lut = ( T ) => texture( lutTexture, vec2( T.div( LUT_TMAX ), 0.5 ) ).rgb;

	const aBase = attribute( 'aBase', 'vec3' );
	const aBaseNormal = attribute( 'aBaseNormal', 'vec3' );
	const aHeat = attribute( 'aHeat', 'float' );
	const aMelt = attribute( 'aMelt', 'float' );

	const mat = new THREE.MeshStandardNodeMaterial( { metalness: 0.0 } );

	const albedoTex = triplanar( rockTex, aBase, aBaseNormal, 0.42 );
	const detailTex = triplanar( rockTex, aBase, aBaseNormal, 1.7 );
	const height = heightOf( albedoTex ).mul( 0.7 ).add( heightOf( detailTex ).mul( 0.3 ) );

	// rachaduras: o brilho aparece primeiro nas fendas e depois toma a superfície
	const crackN = texture3D( noiseTexture, aBase.mul( 0.55 ).add( vec3( 0, uTime.mul( 0.012 ), 0 ) ) ).a;
	const fineN = texture3D( noiseTexture, aBase.mul( 1.9 ).add( vec3( uTime.mul( 0.02 ), 0, 0 ) ) ).a;
	const cracks = smoothstep( 0.42, 0.5, crackN ).mul( smoothstep( 0.58, 0.5, crackN ) ); // linhas onde o ruído cruza 0.5
	const heatVis = aHeat.mul( float( 0.62 ).add( cracks.mul( 0.5 ) ).add( fineN.sub( 0.5 ).mul( 0.35 ) ).add( float( 1 ).sub( height ).mul( 0.25 ) ) )
		.add( aMelt.mul( 0.35 ) );

	const charred = smoothstep( 0.05, 0.5, aHeat.add( aMelt ) );
	const albedo = albedoTex.rgb.mul( detailTex.rgb.mul( 1.3 ).add( 0.3 ) ).mul( 0.85 ).mul( float( 1 ).sub( charred.mul( 0.72 ) ) );

	mat.colorNode = albedo;
	mat.roughnessNode = mix( float( 0.92 ).sub( height.mul( 0.2 ) ), float( 0.28 ), smoothstep( 0.55, 1.0, aHeat ) );
	mat.normalNode = bumpMap( height, mix( float( 3.0 ), float( 0.6 ), smoothstep( 0.6, 1.0, aHeat ) ) );
	mat.emissiveNode = lut( min( heatVis, 1.05 ) ).mul( 1.15 ).add( fireGI( positionWorld, normalWorld ).mul( albedo ).mul( 1.6 ) );

	const mesh = new THREE.Mesh( geo, mat );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.frustumCulled = false;
	scene.add( mesh );

	// ---- poça de lava ---------------------------------------------------

	const poolHeat = uniform( 0 );
	const poolGeo = new THREE.CircleGeometry( 1, 96, 0, Math.PI * 2 );
	poolGeo.rotateX( - Math.PI / 2 );
	const poolMat = new THREE.MeshStandardNodeMaterial( { metalness: 0.0, transparent: true } );

	{

		const r = uv().sub( 0.5 ).length().mul( 2.0 );
		const ang = positionLocal.xz.normalize();
		// borda irregular
		const edgeN = texture3D( noiseTexture, vec3( ang.mul( 0.35 ), 0.3 ) ).a;
		const rim = float( 0.72 ).add( edgeN.mul( 0.5 ) );
		const flowP = vec3( positionWorld.xz.mul( 0.5 ), uTime.mul( 0.03 ) );
		const n1 = texture3D( noiseTexture, flowP ).a;
		const n2 = texture3D( noiseTexture, flowP.mul( 2.6 ).add( 0.31 ) ).a;
		const crust = smoothstep( 0.35, 0.65, n1.mul( 0.65 ).add( n2.mul( 0.35 ) ) );
		const inner = smoothstep( rim, rim.mul( 0.25 ), r );
		const temp = poolHeat.mul( inner.mul( 0.55 ).add( 0.45 ) ).mul( float( 1.1 ).sub( crust.mul( 0.85 ) ) );

		poolMat.colorNode = mix( vec3( 0.012, 0.01, 0.009 ), vec3( 0.03, 0.022, 0.018 ), crust );
		poolMat.roughnessNode = mix( float( 0.5 ), float( 0.9 ), crust );
		poolMat.normalNode = bumpMap( crust.mul( 0.6 ).add( n2.mul( 0.4 ) ), 1.2 );
		poolMat.emissiveNode = lut( min( temp, 0.98 ) ).mul( 1.15 );
		poolMat.opacityNode = smoothstep( rim, rim.mul( 0.9 ), r );

	}

	const pool = new THREE.Mesh( poolGeo, poolMat );
	pool.position.set( base.x, 0.025, base.z );
	pool.receiveShadow = true;
	pool.renderOrder = 1;
	scene.add( pool );

	// ---- gotas de lava --------------------------------------------------

	const dripGeo = new THREE.SphereGeometry( 1, 8, 6 );
	const dripMat = new THREE.MeshBasicNodeMaterial();
	dripMat.colorNode = vec3( 5.0, 1.5, 0.2 );
	const drips = new THREE.InstancedMesh( dripGeo, dripMat, DRIPS );
	drips.frustumCulled = false;
	drips.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
	scene.add( drips );

	const dripPos = new Float32Array( DRIPS * 3 );
	const dripVel = new Float32Array( DRIPS * 3 );
	const dripLife = new Float32Array( DRIPS );
	const dripSize = new Float32Array( DRIPS );
	let dripCursor = 0;
	const dummy = new THREE.Object3D();
	const vDir = new THREE.Vector3();
	const UP = new THREE.Vector3( 0, 1, 0 );

	// ---- estado ---------------------------------------------------------

	const state = {
		melted: 0, peakHeat: 0, avgHeat: 0, done: false, smoke: 0, glow: 0, exposure: 0,
		obstacleRadius: new THREE.Vector3( ROCK_RADIUS, ROCK_RADIUS * 0.9, ROCK_RADIUS ),
		obstacleCenter: ROCK_CENTER.clone(),
		hotPoint: ROCK_CENTER.clone()
	};

	// forma atual da pedra para a simulação: raio máximo por direção a partir da base
	const bins = new Float32Array( SHAPE_W * SHAPE_H );
	const binsTmp = new Float32Array( SHAPE_W * SHAPE_H );

	function writeShape() {

		bins.fill( 0 );

		if ( ! state.done ) {

			const pos = geo.attributes.position.array;

			for ( let i = 0; i < count; i ++ ) {

				const x = pos[ i * 3 ] - base.x, y = pos[ i * 3 + 1 ], z = pos[ i * 3 + 2 ] - base.z;
				const r = Math.sqrt( x * x + y * y + z * z );
				if ( r < 1e-4 ) continue;
				const az = Math.atan2( z, x ) / ( Math.PI * 2 ) + 0.5;
				const el = Math.asin( Math.min( 1, Math.max( 0, y / r ) ) ) / ( Math.PI / 2 );
				const k = Math.min( SHAPE_H - 1, el * SHAPE_H | 0 ) * SHAPE_W + Math.min( SHAPE_W - 1, az * SHAPE_W | 0 );
				if ( r > bins[ k ] ) bins[ k ] = r;

			}

			// direções sem vértice (perto do zênite) herdam dos vizinhos
			for ( let pass = 0; pass < 2; pass ++ ) {

				binsTmp.set( bins );

				for ( let by = 0; by < SHAPE_H; by ++ ) for ( let bx = 0; bx < SHAPE_W; bx ++ ) {

					const k = by * SHAPE_W + bx;
					if ( binsTmp[ k ] > 0 ) continue;
					const l = by * SHAPE_W + ( bx + SHAPE_W - 1 ) % SHAPE_W, r = by * SHAPE_W + ( bx + 1 ) % SHAPE_W;
					const d = Math.max( 0, by - 1 ) * SHAPE_W + bx, t = Math.min( SHAPE_H - 1, by + 1 ) * SHAPE_W + bx;
					bins[ k ] = Math.max( binsTmp[ l ], binsTmp[ r ], binsTmp[ d ], binsTmp[ t ] );

				}

			}

		}

		const data = sim.shapeData;
		for ( let k = 0; k < bins.length; k ++ ) data[ k * 4 ] = Math.min( 255, Math.round( bins[ k ] / SHAPE_MAX * 255 ) );
		sim.shapeTex.needsUpdate = true;

	}

	let shapeTick = 0;
	let seed = 3.7;
	let poolTemp = 0;
	let finish = 0;

	function reset() {

		seed += 11.31;
		heat.fill( 0 ); melt.fill( 0 );
		state.melted = 0; state.peakHeat = 0; state.avgHeat = 0; state.done = false; state.exposure = 0;
		poolTemp = 0; finish = 0;
		dripLife.fill( 0 );
		buildShape( seed );
		mesh.visible = true;
		writeShape();

	}

	buildShape( seed );
	writeShape();

	function update( dt, time, impact, jetDir ) {

		const pos = geo.attributes.position.array;
		const mx = MOUTH_POS.x, my = MOUTH_POS.y, mz = MOUTH_POS.z;
		const jx = jetDir.x, jy = jetDir.y, jz = jetDir.z;

		if ( impact > 0.05 ) state.exposure += dt * impact;

		// quanto mais a pedra some, mais as chamas a envolvem
		const wrap = 0.2 + 0.55 * state.melted;
		const active = impact > 0.01 || state.avgHeat > 0.004;

		let sumMelt = 0, sumHeat = 0, peak = 0;
		let hotI = - 1, hotV = 0;

		if ( active || finish > 0 ) {

			// condução
			for ( let i = 0; i < count; i ++ ) {

				let s = 0;
				const a = adjStart[ i ], b = adjStart[ i + 1 ];
				for ( let k = a; k < b; k ++ ) s += heat[ adj[ k ] ];
				heatTmp[ i ] = s / ( b - a );

			}

			const cond = Math.min( 1, dt * 2.2 );

			for ( let i = 0; i < count; i ++ ) {

				const i3 = i * 3;
				let h = heat[ i ] + ( heatTmp[ i ] - heat[ i ] ) * cond;
				let m = melt[ i ];

				if ( impact > 0.01 && m < 1 ) {

					const nx = baseNrm[ i3 ], ny = baseNrm[ i3 + 1 ], nz = baseNrm[ i3 + 2 ];
					const facing = Math.max( 0, - ( nx * jx + ny * jy + nz * jz ) );
					const rx = pos[ i3 ] - mx, ry = pos[ i3 + 1 ] - my, rz = pos[ i3 + 2 ] - mz;
					const along = rx * jx + ry * jy + rz * jz;
					const px = rx - jx * along, py = ry - jy * along, pz = rz - jz * along;
					const d2 = px * px + py * py + pz * pz;
					const beam = Math.exp( - d2 / 1.7 );
					const e = impact * ( Math.pow( facing, 0.75 ) * beam * 1.15 + wrap * ( 0.6 + 0.4 * Math.max( 0, ny ) ) );
					h += e * 0.62 * jitter[ i ] * dt;

				}

				// resfriamento (radiativo: mais rápido quanto mais quente)
				h -= h * ( 0.035 + 0.11 * h ) * dt * ( 1 - impact * 0.75 );
				if ( h > 1.45 ) h = 1.45;

				if ( h > MELT_POINT && m < 1 ) {

					m += ( h - MELT_POINT ) * 0.16 * jitter[ i ] * dt + finish * dt;
					if ( m > 1 ) m = 1;

				} else if ( finish > 0 && m < 1 ) {

					m = Math.min( 1, m + finish * dt );

				}

				heat[ i ] = h; melt[ i ] = m;
				sumMelt += m; sumHeat += h;
				if ( h > peak ) peak = h;

				// posição: escorre para a base
				const s = m * m * ( 3 - 2 * m );
				const k = 1 - s * 0.985;
				const bx = basePos[ i3 ], by = basePos[ i3 + 1 ], bz = basePos[ i3 + 2 ];
				const sag = m * ( 1 - m ) * 0.9; // parte derretida cede antes de sumir
				pos[ i3 ] = base.x + ( bx - base.x ) * ( k + sag * 0.12 );
				pos[ i3 + 1 ] = Math.max( 0.015, base.y + ( by - base.y ) * k * ( 1 - sag * 0.55 ) );
				pos[ i3 + 2 ] = base.z + ( bz - base.z ) * ( k + sag * 0.12 );

				if ( m > 0.08 && m < 0.9 && h > 0.8 ) {

					const score = h * jitter[ i ] * ( ( i * 2654435761 + ( time * 60 | 0 ) * 40503 ) % 997 ) / 997;
					if ( score > hotV ) { hotV = score; hotI = i; }

				}

			}

			geo.attributes.position.needsUpdate = true;
			geo.attributes.aHeat.needsUpdate = true;
			geo.attributes.aMelt.needsUpdate = true;
			geo.computeVertexNormals();

			state.melted = sumMelt / count;
			state.avgHeat = sumHeat / count;
			state.peakHeat = peak;

			if ( ( shapeTick ++ ) % 3 === 0 ) writeShape();

		}

		// fim: o resto desaba rápido
		if ( state.melted > 0.9 && ! state.done ) finish = 0.6;

		if ( state.melted >= 0.995 && ! state.done ) {

			state.done = true;
			mesh.visible = false;
			finish = 0;
			writeShape();

		}

		// gota de lava no vértice mais quente que está derretendo
		if ( hotI >= 0 && Math.random() < dt * 34 ) {

			const d = dripCursor = ( dripCursor + 1 ) % DRIPS;
			dripPos[ d * 3 ] = pos[ hotI * 3 ]; dripPos[ d * 3 + 1 ] = pos[ hotI * 3 + 1 ]; dripPos[ d * 3 + 2 ] = pos[ hotI * 3 + 2 ];
			dripVel[ d * 3 ] = baseNrm[ hotI * 3 ] * 0.8 + ( Math.random() - 0.5 ) * 0.6;
			dripVel[ d * 3 + 1 ] = Math.random() * 0.6;
			dripVel[ d * 3 + 2 ] = baseNrm[ hotI * 3 + 2 ] * 0.8 + ( Math.random() - 0.5 ) * 0.6;
			dripLife[ d ] = 1;
			dripSize[ d ] = 0.018 + Math.random() * 0.03;
			state.hotPoint.set( pos[ hotI * 3 ], pos[ hotI * 3 + 1 ], pos[ hotI * 3 + 2 ] );

		}

		for ( let d = 0; d < DRIPS; d ++ ) {

			if ( dripLife[ d ] > 0 ) {

				dripVel[ d * 3 + 1 ] -= 9.8 * dt;
				dripPos[ d * 3 ] += dripVel[ d * 3 ] * dt;
				dripPos[ d * 3 + 1 ] += dripVel[ d * 3 + 1 ] * dt;
				dripPos[ d * 3 + 2 ] += dripVel[ d * 3 + 2 ] * dt;
				if ( dripPos[ d * 3 + 1 ] < 0.03 ) dripLife[ d ] = 0;

				vDir.set( dripVel[ d * 3 ], dripVel[ d * 3 + 1 ], dripVel[ d * 3 + 2 ] );
				const sp = vDir.length();
				dummy.position.set( dripPos[ d * 3 ], dripPos[ d * 3 + 1 ], dripPos[ d * 3 + 2 ] );
				dummy.quaternion.setFromUnitVectors( UP, vDir.normalize() );
				const sz = dripLife[ d ] > 0 ? dripSize[ d ] : 0;
				dummy.scale.set( sz, sz * ( 1 + sp * 0.35 ), sz );

			} else {

				dummy.position.set( 0, - 10, 0 );
				dummy.scale.setScalar( 0 );

			}

			dummy.updateMatrix();
			drips.setMatrixAt( d, dummy.matrix );

		}

		drips.instanceMatrix.needsUpdate = true;

		// poça: cresce com o que derreteu, aquece com o fogo, esfria devagar
		const targetTemp = Math.min( 1.05, state.melted * 3 ) * ( 0.55 + 0.6 * impact );
		poolTemp += ( targetTemp - poolTemp ) * Math.min( 1, dt * ( targetTemp > poolTemp ? 1.2 : 0.07 ) );
		poolHeat.value = poolTemp;
		const pr = 0.35 + 2.2 * Math.sqrt( state.melted );
		pool.scale.set( pr * 1.12, 1, pr );
		pool.visible = state.melted > 0.004;

		// obstáculo da simulação encolhe junto
		const k = Math.pow( Math.max( 0, 1 - state.melted ), 0.55 );
		state.obstacleRadius.set( ROCK_RADIUS, ROCK_RADIUS * 0.9, ROCK_RADIUS ).multiplyScalar( state.done ? 0.001 : Math.max( 0.02, k ) );
		state.obstacleCenter.set( ROCK_CENTER.x, ROCK_CENTER.y * Math.max( 0.05, k ), ROCK_CENTER.z );

		state.smoke = state.done ? poolTemp * 0.6 : Math.min( 1.6, state.avgHeat * 2.6 ) * ( 1 - state.melted * 0.5 );
		state.glow = state.avgHeat * state.avgHeat * ( 1 - state.melted ) + poolTemp * poolTemp * Math.min( 1, state.melted * 2 ) * 0.6;

	}

	return { mesh, pool, state, update, reset };

}
