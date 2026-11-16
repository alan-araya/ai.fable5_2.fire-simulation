import * as THREE from 'three/webgpu';
import { LUT_TMAX } from './config.js';

// ---------------------------------------------------------------
// Blackbody LUT
// Cor: lei de Planck integrada com as curvas CIE 1931 (ajuste analítico
// de Wyman et al. 2013), convertida para sRGB linear.
// Intensidade: curva comprimida (a real cresce ~T^4 no total e muito mais
// no visível, o que não cabe em HDR de tempo real).
// ---------------------------------------------------------------

function cieXYZ( lambda ) {

	const g = ( x, mu, s1, s2 ) => {

		const t = ( x - mu ) / ( x < mu ? s1 : s2 );
		return Math.exp( - 0.5 * t * t );

	};

	const x = 1.056 * g( lambda, 599.8, 37.9, 31.0 ) + 0.362 * g( lambda, 442.0, 16.0, 26.7 ) - 0.065 * g( lambda, 501.1, 20.4, 26.2 );
	const y = 0.821 * g( lambda, 568.8, 46.9, 40.5 ) + 0.286 * g( lambda, 530.9, 16.3, 31.1 );
	const z = 1.217 * g( lambda, 437.0, 11.8, 36.0 ) + 0.681 * g( lambda, 459.0, 26.0, 13.8 );
	return [ x, y, z ];

}

export function blackbodyRGB( kelvin ) {

	let X = 0, Y = 0, Z = 0;
	const c2 = 1.4388e7; // nm*K

	for ( let l = 380; l <= 780; l += 5 ) {

		const planck = 1 / ( Math.pow( l, 5 ) * ( Math.exp( c2 / ( l * kelvin ) ) - 1 ) );
		const [ x, y, z ] = cieXYZ( l );
		X += planck * x; Y += planck * y; Z += planck * z;

	}

	let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
	let g = - 0.9689 * X + 1.8758 * Y + 0.0415 * Z;
	let b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;

	r = Math.max( r, 0 ); g = Math.max( g, 0 ); b = Math.max( b, 0 );
	const m = Math.max( r, g, b, 1e-30 );
	return [ r / m, g / m, b / m ];

}

// temperatura normalizada -> Kelvin
export function tempToKelvin( t ) {

	return 800 + t * 1100; // t=1 -> 1900 K (chama de fuligem), t=2 -> 3000 K

}

export function fireColor( t ) {

	const [ r, g, b ] = blackbodyRGB( tempToKelvin( t ) );

	// brilho: nada abaixo do "ponto de Draper" (~0.15), depois sobe rápido
	const on = THREE.MathUtils.smoothstep( t, 0.1, 0.4 );
	const intensity = on * Math.pow( t, 2.2 ) * ( 1 + 0.9 * t * t );

	// brasa: vermelho mais profundo e saturado nas bordas frias
	const sat = THREE.MathUtils.smoothstep( t, 0.2, 0.9 );
	const gg = g * ( 0.72 + 0.28 * sat );
	const bb = b * ( 0.5 + 0.5 * sat );

	return [ r * intensity, gg * intensity, bb * intensity ];

}

export function createBlackbodyLUT( size = 256 ) {

	const data = new Uint16Array( size * 4 );

	for ( let i = 0; i < size; i ++ ) {

		const t = ( i / ( size - 1 ) ) * LUT_TMAX;
		const [ r, g, b ] = fireColor( t );
		data[ i * 4 + 0 ] = THREE.DataUtils.toHalfFloat( r );
		data[ i * 4 + 1 ] = THREE.DataUtils.toHalfFloat( g );
		data[ i * 4 + 2 ] = THREE.DataUtils.toHalfFloat( b );
		data[ i * 4 + 3 ] = THREE.DataUtils.toHalfFloat( 1 );

	}

	const tex = new THREE.DataTexture( data, size, 1, THREE.RGBAFormat, THREE.HalfFloatType );
	tex.minFilter = THREE.LinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.wrapS = THREE.ClampToEdgeWrapping;
	tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.needsUpdate = true;
	return tex;

}

// ---------------------------------------------------------------
// Textura 3D de ruído periódico (RGBA8, repete sem emenda)
// rgb = campo vetorial sem divergência (soma de ondas com amplitude
//       perpendicular ao vetor de onda) -> turbulência que não comprime o gás
// a   = fbm escalar periódico (detalhe)
// ---------------------------------------------------------------

export function createNoiseTexture3D( size = 64 ) {

	const rand = mulberry32( 1337 );
	const waves = [];

	// espectro de Kolmogorov: redemoinhos grandes carregam a energia, os pequenos
	// só acrescentam dobras (amplitude ~ |k|^-5/6)
	while ( waves.length < 64 ) {

		const k = new THREE.Vector3(
			Math.round( rand() * 20 - 10 ),
			Math.round( rand() * 20 - 10 ),
			Math.round( rand() * 20 - 10 )
		);
		const len = k.length();
		if ( len < 2 || len > 10 ) continue;

		const r = new THREE.Vector3( rand() - 0.5, rand() - 0.5, rand() - 0.5 );
		const a = r.cross( k ).normalize().multiplyScalar( Math.pow( len, - 5 / 6 ) );
		waves.push( { k, a, phase: rand() * Math.PI * 2 } );

	}

	// fbm periódico barato: ondas escalares de várias frequências
	const swaves = [];
	for ( let i = 0; i < 40; i ++ ) {

		const oct = 1 + Math.floor( rand() * 3 );
		const f = Math.pow( 2, oct );
		const k = new THREE.Vector3(
			Math.round( ( rand() * 2 - 1 ) * f ),
			Math.round( ( rand() * 2 - 1 ) * f ),
			Math.round( ( rand() * 2 - 1 ) * f )
		);
		if ( k.lengthSq() === 0 ) k.set( 1, 1, 2 );
		swaves.push( { k, amp: 1 / k.length(), phase: rand() * Math.PI * 2 } );

	}

	const data = new Uint8Array( size * size * size * 4 );
	const tmp = new Float32Array( size * size * size * 4 );
	const TAU = Math.PI * 2;
	let maxV = 0, maxS = 0;
	let i = 0;

	for ( let z = 0; z < size; z ++ ) {

		for ( let y = 0; y < size; y ++ ) {

			for ( let x = 0; x < size; x ++ ) {

				const px = x / size, py = y / size, pz = z / size;
				let vx = 0, vy = 0, vz = 0;

				for ( const w of waves ) {

					const s = Math.sin( TAU * ( w.k.x * px + w.k.y * py + w.k.z * pz ) + w.phase );
					vx += w.a.x * s; vy += w.a.y * s; vz += w.a.z * s;

				}

				let sc = 0;
				for ( const w of swaves ) sc += w.amp * Math.sin( TAU * ( w.k.x * px + w.k.y * py + w.k.z * pz ) + w.phase );

				tmp[ i ++ ] = vx; tmp[ i ++ ] = vy; tmp[ i ++ ] = vz; tmp[ i ++ ] = sc;
				maxV = Math.max( maxV, Math.abs( vx ), Math.abs( vy ), Math.abs( vz ) );
				maxS = Math.max( maxS, Math.abs( sc ) );

			}

		}

	}

	for ( let j = 0; j < tmp.length; j += 4 ) {

		data[ j ] = Math.round( ( tmp[ j ] / maxV * 0.5 + 0.5 ) * 255 );
		data[ j + 1 ] = Math.round( ( tmp[ j + 1 ] / maxV * 0.5 + 0.5 ) * 255 );
		data[ j + 2 ] = Math.round( ( tmp[ j + 2 ] / maxV * 0.5 + 0.5 ) * 255 );
		data[ j + 3 ] = Math.round( ( tmp[ j + 3 ] / maxS * 0.5 + 0.5 ) * 255 );

	}

	const tex = new THREE.Data3DTexture( data, size, size, size );
	tex.format = THREE.RGBAFormat;
	tex.type = THREE.UnsignedByteType;
	tex.minFilter = THREE.LinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
	tex.needsUpdate = true;
	return tex;

}

export function mulberry32( a ) {

	return function () {

		let t = a += 0x6D2B79F5;
		t = Math.imul( t ^ t >>> 15, t | 1 );
		t ^= t + Math.imul( t ^ t >>> 7, t | 61 );
		return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296;

	};

}
