import * as THREE from 'three/webgpu';

// ---------------------------------------------------------------
// Quality presets (?q=low|medium|high|ultra|inferno)
// grid   = resolução da grade de gás (fuligem / temperatura / combustível)
//          velocidade e pressão rodam em metade disso (8x mais barato)
// steps  = passos do raymarch (o filtro temporal média o ruído do passo aleatório)
// scale  = escala de resolução do raymarch · maxWidth = teto em pixels (telas 4K não explodem o custo)
// mac    = advecção MacCormack no gás (mais nítida, um passe a mais)
// jacobi = iterações do solver de pressão (sempre par)
// embers = quantidade de brasas (partículas GPU)
// ---------------------------------------------------------------

export const QUALITY_PRESETS = {
	potato: { grid: [ 96, 48, 48 ], steps: 40, scale: 0.4, maxWidth: 640, jacobi: 8, mac: false, embers: 2000, shadow: 512, pixelRatio: 1 },
	low: { grid: [ 128, 64, 64 ], steps: 56, scale: 0.5, maxWidth: 800, jacobi: 12, mac: false, embers: 6000, shadow: 512, pixelRatio: 1 },
	medium: { grid: [ 192, 96, 96 ], steps: 72, scale: 0.5, maxWidth: 960, jacobi: 16, mac: true, embers: 12000, shadow: 1024, pixelRatio: 1 },
	high: { grid: [ 256, 128, 128 ], steps: 96, scale: 0.6, maxWidth: 1152, jacobi: 20, mac: true, embers: 24000, shadow: 1024, pixelRatio: 1 },
	ultra: { grid: [ 320, 160, 160 ], steps: 128, scale: 0.8, maxWidth: 1600, jacobi: 28, mac: true, embers: 40000, shadow: 2048, pixelRatio: 1 },
	inferno: { grid: [ 384, 192, 192 ], steps: 176, scale: 1.0, maxWidth: 4096, jacobi: 40, mac: true, embers: 80000, shadow: 2048, pixelRatio: Math.min( window.devicePixelRatio, 2 ) }
};

export function getQuality() {

	const q = new URLSearchParams( location.search ).get( 'q' );
	const name = QUALITY_PRESETS[ q ] ? q : 'high';
	return { name, ...QUALITY_PRESETS[ name ] };

}

// ---------------------------------------------------------------
// World layout (metros). O jato sai da boca do dragão em +X e desce
// levemente até a pedra. O volume simulado é uma caixa alinhada aos eixos.
// ---------------------------------------------------------------

export const BOX_MIN = new THREE.Vector3( - 6, 0, - 4 );
export const BOX_SIZE = new THREE.Vector3( 16, 8, 8 );
export const BOX_MAX = BOX_MIN.clone().add( BOX_SIZE );

export const MOUTH_POS = new THREE.Vector3( - 4.7, 3.15, 0 );
export const ROCK_CENTER = new THREE.Vector3( 2.4, 1.2, 0 );
export const ROCK_RADIUS = 1.35;

export const JET_DIR = ROCK_CENTER.clone().add( new THREE.Vector3( 0, 0.15, 0 ) ).sub( MOUTH_POS ).normalize();

// temperatura normalizada: LUT cobre 0..LUT_TMAX
export const LUT_TMAX = 2.0;
