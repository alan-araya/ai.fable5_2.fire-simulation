import * as THREE from 'three/webgpu';
import {
	Fn, vec2, vec3, vec4, float, uniform, texture, positionWorld, normalWorld, positionLocal,
	smoothstep, mix, max, min, dot, pow, bumpMap, fract, sin, floor, uv
} from 'three/tsl';

import { BOX_MIN, BOX_SIZE, ROCK_CENTER } from './config.js';
import { mulberry32 } from './lut.js';

const SIZE = vec3( BOX_SIZE.x, BOX_SIZE.y, BOX_SIZE.z );
const BMIN = vec3( BOX_MIN.x, BOX_MIN.y, BOX_MIN.z );

export const MOON_DIR = new THREE.Vector3( - 0.55, 0.5, - 0.67 ).normalize();

// ---------------------------------------------------------------
// Iluminação global do fogo: superfícies leem o volume de luz difundido
// pela simulação, então o clarão acompanha as chamas de verdade.
// ---------------------------------------------------------------

export function makeFireGI( sim ) {

	const gain = uniform( 2.2 );

	const fn = ( worldPos, normal ) => {

		const uvw = worldPos.add( normal.mul( 0.35 ) ).sub( BMIN ).div( SIZE );
		const edge = min( uvw, vec3( 1 ).sub( uvw ) );
		const inside = smoothstep( - 0.02, 0.06, min( edge.x, min( edge.y.add( 0.06 ), edge.z ) ) );
		const at = uvw.clamp( 0.0, 1.0 );
		// luz próxima com teto suave (não estoura junto da chama) + luz distante que atravessa a cena
		const near = sim.lightNode.sample( at ).rgb;
		const far = sim.lightFarNode.sample( at ).rgb;
		return near.div( near.x.mul( 1.6 ).add( 1 ) ).add( far.mul( 1.6 ) ).mul( inside ).mul( gain );

	};

	fn.gain = gain;
	return fn;

}

export function loadTexture( url, repeat = true ) {

	const tex = new THREE.TextureLoader().load( url );
	tex.colorSpace = THREE.SRGBColorSpace;
	if ( repeat ) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.anisotropy = 8;
	return tex;

}

// luminância de uma textura como altura (para bump)
export const heightOf = ( colorNode ) => dot( colorNode.rgb, vec3( 0.299, 0.587, 0.114 ) );

export function createEnvironment( scene, fireGI, quality ) {

	// ---- céu: crepúsculo tempestuoso, estrelas e lua ---------------------

	const skyMat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, depthWrite: false, fog: false } );

	skyMat.colorNode = Fn( () => {

		const dir = positionLocal.normalize();
		const h = dir.y;

		const horizon = vec3( 0.050, 0.040, 0.050 );
		const zenith = vec3( 0.004, 0.006, 0.014 );
		const col = mix( horizon, zenith, smoothstep( - 0.05, 0.55, h ) ).toVar();

		// brasa distante no horizonte (como se a ilha ainda ardesse)
		const glow = smoothstep( 0.25, - 0.05, h ).mul( pow( max( dot( dir.xz.normalize(), vec2( 0.85, 0.52 ) ), 0.0 ), 6.0 ) );
		col.addAssign( vec3( 0.16, 0.045, 0.012 ).mul( glow ) );

		// estrelas
		const g = dir.mul( 220.0 );
		const cell = floor( g );
		const rnd = fract( sin( dot( cell, vec3( 12.9898, 78.233, 37.719 ) ) ).mul( 43758.5453 ) );
		const f = fract( g ).sub( 0.5 );
		const star = smoothstep( 0.16, 0.0, f.length() ).mul( smoothstep( 0.985, 1.0, rnd ) ).mul( smoothstep( 0.02, 0.3, h ) );
		col.addAssign( vec3( 0.9, 0.95, 1.0 ).mul( star ).mul( 1.6 ) );

		// lua
		const m = dot( dir, vec3( MOON_DIR.x, MOON_DIR.y, MOON_DIR.z ) );
		col.addAssign( vec3( 0.75, 0.85, 1.0 ).mul( smoothstep( 0.9993, 0.9996, m ).mul( 3.0 ) ) );
		col.addAssign( vec3( 0.10, 0.13, 0.2 ).mul( pow( max( m, 0.0 ), 90.0 ) ) );
		col.addAssign( vec3( 0.02, 0.03, 0.05 ).mul( pow( max( m, 0.0 ), 8.0 ) ) );

		return col;

	} )();

	const sky = new THREE.Mesh( new THREE.SphereGeometry( 400, 48, 24 ), skyMat );
	sky.frustumCulled = false;
	scene.add( sky );

	scene.fog = new THREE.FogExp2( 0x07080b, 0.011 );

	// ---- luzes ---------------------------------------------------------

	const moon = new THREE.DirectionalLight( 0x9db4ff, 2.2 );
	moon.position.copy( MOON_DIR ).multiplyScalar( 60 );
	moon.target.position.set( 0, 0, 0 );
	moon.castShadow = true;
	moon.shadow.mapSize.set( quality.shadow, quality.shadow );
	moon.shadow.camera.left = - 22; moon.shadow.camera.right = 22;
	moon.shadow.camera.top = 22; moon.shadow.camera.bottom = - 22;
	moon.shadow.camera.near = 10; moon.shadow.camera.far = 140;
	moon.shadow.bias = - 0.0006;
	moon.shadow.normalBias = 0.04;
	scene.add( moon, moon.target );

	scene.add( new THREE.HemisphereLight( 0x2a3552, 0x120c0a, 1.1 ) );

	// ---- chão ----------------------------------------------------------

	const groundTex = loadTexture( '/textures/ground.png' );

	const groundMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.95, metalness: 0.0 } );
	const scorch = uniform( 0 ); // 0..1 — quanto o chão ao redor da pedra já queimou

	const gUV = positionWorld.xz.mul( 0.22 );
	const gA = texture( groundTex, gUV );
	const gB = texture( groundTex, gUV.mul( 0.23 ).add( vec2( 0.37, 0.11 ) ) );
	const gCol = gA.rgb.mul( gB.rgb.mul( 1.6 ).add( 0.25 ) );

	// mancha de queimado sob o jato e ao redor da pedra
	const toRock = positionWorld.xz.sub( vec2( ROCK_CENTER.x, ROCK_CENTER.z ) );
	const burnMask = smoothstep( 6.5, 1.0, toRock.mul( vec2( 0.7, 1.0 ) ).length() ).mul( scorch );

	groundMat.colorNode = gCol.mul( 0.55 ).mul( float( 1 ).sub( burnMask.mul( 0.8 ) ) );
	groundMat.normalNode = bumpMap( heightOf( gA ).mul( 0.9 ).add( heightOf( gB ).mul( 0.6 ) ), 2.2 );
	groundMat.roughnessNode = float( 0.95 ).sub( heightOf( gA ).mul( 0.25 ) );
	groundMat.emissiveNode = fireGI( positionWorld, vec3( 0, 1, 0 ) ).mul( gCol ).mul( 1.4 );

	const ground = new THREE.Mesh( new THREE.PlaneGeometry( 600, 600 ), groundMat );
	ground.rotation.x = - Math.PI / 2;
	ground.receiveShadow = true;
	scene.add( ground );

	// ---- silhueta de montanhas / penhascos ao longe ----------------------

	const rand = mulberry32( 77 );
	const ridge = new THREE.BufferGeometry();
	const verts = [];
	const SEG = 220;

	for ( const [ radius, hMin, hMax ] of [ [ 170, 3, 22 ], [ 260, 12, 52 ] ] ) {

		let h = hMin + rand() * ( hMax - hMin );
		const hs = [];
		for ( let i = 0; i <= SEG; i ++ ) {

			h += ( rand() - 0.5 ) * ( hMax - hMin ) * 0.32;
			h = Math.min( hMax, Math.max( hMin, h ) );
			hs.push( h );

		}

		hs[ SEG ] = hs[ 0 ];

		for ( let i = 0; i < SEG; i ++ ) {

			const a0 = i / SEG * Math.PI * 2, a1 = ( i + 1 ) / SEG * Math.PI * 2;
			const x0 = Math.cos( a0 ) * radius, z0 = Math.sin( a0 ) * radius;
			const x1 = Math.cos( a1 ) * radius, z1 = Math.sin( a1 ) * radius;
			verts.push( x0, - 2, z0, x1, - 2, z1, x1, hs[ i + 1 ], z1, x0, - 2, z0, x1, hs[ i + 1 ], z1, x0, hs[ i ], z0 );

		}

	}

	ridge.setAttribute( 'position', new THREE.Float32BufferAttribute( verts, 3 ) );
	const ridgeMat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide, fog: false } );
	ridgeMat.colorNode = mix( vec3( 0.022, 0.018, 0.022 ), vec3( 0.006, 0.007, 0.011 ), smoothstep( 0.0, 60.0, positionWorld.y ) );
	const ridgeMesh = new THREE.Mesh( ridge, ridgeMat );
	ridgeMesh.frustumCulled = false;
	scene.add( ridgeMesh );

	return { sky, moon, ground, uniforms: { scorch } };

}
