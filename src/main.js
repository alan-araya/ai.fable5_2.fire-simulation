import * as THREE from 'three/webgpu';
import { pass, vec2, vec3, vec4, float, uniform, screenUV, texture, texture3D, smoothstep, dot, fract, sin, min } from 'three/tsl';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { getQuality, classifyAdapter, QUALITY_PRESETS, MOUTH_POS, ROCK_CENTER } from './config.js';
import { createBlackbodyLUT, createNoiseTexture3D } from './lut.js';
import { FireSim, SIM_DT } from './fireSim.js';
import { makeVolume, createVolumeUniforms, volumeTunables } from './fireVolume.js';
import { createEnvironment, makeFireGI, MOON_DIR } from './environment.js';
import { createRock } from './rock.js';
import { createDragon } from './dragon.js';
import { createEmbers } from './embers.js';

let quality;
const $ = ( id ) => document.getElementById( id );

init().catch( ( err ) => {

	console.error( err );
	$( 'bootMsg' ).className = 'err';
	$( 'bootMsg' ).textContent = 'Falha ao iniciar: ' + ( err && err.message ? err.message : err );

} );

async function init() {

	if ( ! navigator.gpu ) {

		throw new Error( 'este simulador precisa de WebGPU (Chrome ou Edge recentes, com aceleração por hardware ligada).' );

	}

	// ---- GPU ------------------------------------------------------------
	// No Windows o Chrome/Edge usam um único adaptador para o navegador todo e
	// ignoram powerPreference: a página não consegue pedir a placa dedicada.
	// Então lemos qual GPU veio, ajustamos a qualidade e avisamos o usuário.

	let gpuName = '', gpuKind = 'discrete';
	try {

		const info = ( await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } ) ).info;
		gpuName = ( info.description || `${ info.vendor } ${ info.architecture }` ).trim();
		gpuKind = classifyAdapter( info );

	} catch ( e ) { /* sem info do adaptador */ }

	quality = getQuality( gpuKind );
	showGpuNotice( gpuKind, gpuName );

	// ---- renderer -------------------------------------------------------

	const viewSize = () => [ Math.max( 16, window.innerWidth ), Math.max( 16, window.innerHeight ) ];

	const renderer = new THREE.WebGPURenderer( { antialias: false, powerPreference: 'high-performance' } );
	renderer.setPixelRatio( quality.pixelRatio );
	renderer.setSize( ...viewSize() );
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.9;
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;
	document.body.prepend( renderer.domElement );

	await renderer.init();

	if ( ! renderer.backend.isWebGPUBackend ) {

		throw new Error( 'o navegador caiu para WebGL — a simulação usa compute shaders, que só existem em WebGPU.' );

	}

	const device = renderer.backend.device;

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera( 42, viewSize()[ 0 ] / viewSize()[ 1 ], 0.1, 900 );
	camera.position.set( 1.2, 3.6, 15.5 );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.target.set( - 2.6, 2.6, 0 );
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;
	controls.minDistance = 3;
	controls.maxDistance = 46;
	controls.maxPolarAngle = Math.PI * 0.495;
	controls.zoomSpeed = 0.8;
	controls.update();

	// ---- simulação ------------------------------------------------------

	const lut = createBlackbodyLUT();
	const noiseTex = createNoiseTexture3D( 64 );
	const sim = new FireSim( renderer, quality, lut, noiseTex, MOON_DIR );
	const fireGI = makeFireGI( sim );

	// ---- cena -----------------------------------------------------------

	const env = createEnvironment( scene, fireGI, quality );
	const rock = createRock( scene, sim, fireGI, lut, noiseTex );
	const dragon = createDragon( scene, fireGI, noiseTex );
	const embers = createEmbers( scene, sim, quality, noiseTex );

	// luzes pontuais do fogo: dão as sombras duras que o volume de luz não dá
	const impactLight = new THREE.PointLight( 0xff7a2a, 0, 60, 1.8 );
	impactLight.castShadow = true;
	impactLight.shadow.mapSize.set( quality.shadow / 2, quality.shadow / 2 );
	impactLight.shadow.camera.near = 0.3;
	impactLight.shadow.camera.far = 50;
	impactLight.shadow.bias = - 0.004;
	scene.add( impactLight );

	const jetLight = new THREE.PointLight( 0xff8a3a, 0, 40, 1.8 );
	scene.add( jetLight );

	// luz de estúdio (tecla L): para inspecionar o dragão e a pedra fora da noite
	const studio = new THREE.Group();
	const studioKey = new THREE.DirectionalLight( 0xfff4e6, 5.0 );
	studioKey.position.set( 6, 12, 14 );
	studio.add( studioKey, new THREE.AmbientLight( 0xb8c4d8, 2.6 ) );
	studio.visible = false;
	scene.add( studio );

	// ---- pós-processamento ----------------------------------------------

	const pipeline = new THREE.RenderPipeline( renderer );
	const scenePass = pass( scene, camera );
	const sceneColor = scenePass.getTextureNode( 'output' );
	const depthTexture = scenePass.getTexture( 'depth' );

	const volumeParams = createVolumeUniforms( MOON_DIR );
	const bufferSize = new THREE.Vector2();

	const buildVolume = () => {

		renderer.getDrawingBufferSize( bufferSize );
		const scale = Math.min( quality.scale, quality.maxWidth / bufferSize.x );
		const w = Math.ceil( ( bufferSize.x * scale ) / 8 ) * 8;
		const h = Math.ceil( ( bufferSize.y * scale ) / 8 ) * 8;
		return makeVolume( renderer, sim, lut, quality, volumeParams, w, h, depthTexture, bufferSize.x, bufferSize.y );

	};

	let volume = buildVolume();
	const vol = texture( volume.texture, screenUV );

	const post = {
		haze: uniform( 0.012 ),
		vignette: uniform( 0.55 ),
		grain: uniform( 0.035 ),
		time: uniform( 0 )
	};

	// miragem de calor: o ar quente distorce o que está atrás do fogo
	const aspect = uniform( camera.aspect );
	const hazeNoise = texture3D( noiseTex, vec3( screenUV.mul( vec2( aspect, 1 ) ).mul( 2.6 ).add( vec2( 0, post.time.mul( 0.35 ) ) ), post.time.mul( 0.23 ) ) ).xy.sub( 0.5 );
	const heat = smoothstep( 0.0, 0.5, vol.a.oneMinus().add( dot( vol.rgb, vec3( 0.05 ) ) ) );
	const background = sceneColor.sample( screenUV.add( hazeNoise.mul( heat ).mul( post.haze ) ) ).rgb;

	// vol.a = quanto do fundo sobra depois do gás
	const hdr = background.mul( vol.a ).add( vol.rgb );
	const bloomPass = bloom( vec4( min( hdr, vec3( 9 ) ), 1.0 ), 0.32, 0.55, 1.1 );

	const centered = screenUV.sub( 0.5 );
	const vignette = float( 1 ).sub( dot( centered, centered ).mul( post.vignette ).mul( 1.6 ) );
	const grainNoise = fract( sin( dot( screenUV.add( fract( post.time ) ), vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) ).sub( 0.5 );
	const graded = hdr.add( bloomPass.rgb ).mul( vignette );

	pipeline.outputNode = vec4( graded.add( graded.add( 0.02 ).mul( grainNoise ).mul( post.grain ).mul( 4.0 ) ), 1.0 );

	// ---- entrada --------------------------------------------------------

	const input = { fire: false, cinematic: false };

	const setFire = ( on ) => {

		input.fire = on;
		$( 'kSpace' ).classList.toggle( 'active', on );

	};

	window.addEventListener( 'keydown', ( e ) => {

		if ( e.code === 'Space' ) {

			e.preventDefault();
			if ( ! e.repeat ) setFire( true );

		}

		if ( e.repeat ) return;
		if ( e.code === 'KeyR' ) resetRock();
		if ( e.code === 'KeyH' ) $( 'hud' ).classList.toggle( 'hidden' );
		if ( e.code === 'KeyG' ) gui.show( gui._hidden );
		if ( e.code === 'KeyC' ) input.cinematic = ! input.cinematic;
		if ( e.code === 'KeyL' ) studio.visible = ! studio.visible;

	} );

	window.addEventListener( 'keyup', ( e ) => {

		if ( e.code === 'Space' ) setFire( false );

	} );

	window.addEventListener( 'blur', () => setFire( false ) );

	const fireBtn = $( 'fireBtn' );
	fireBtn.addEventListener( 'pointerdown', ( e ) => { e.preventDefault(); setFire( true ); } );
	fireBtn.addEventListener( 'pointerup', () => setFire( false ) );
	fireBtn.addEventListener( 'pointerleave', () => setFire( false ) );

	controls.addEventListener( 'start', () => { input.cinematic = false; } );

	function resetRock() {

		rock.reset();
		$( 'done' ).classList.remove( 'show' );

	}

	let resizeTimer = 0;

	window.addEventListener( 'resize', () => {

		const [ w, h ] = viewSize();
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize( w, h );
		aspect.value = camera.aspect;

		// o alvo do raymarch é uma textura de tamanho fixo: refaz quando a janela assenta
		clearTimeout( resizeTimer );
		resizeTimer = setTimeout( () => {

			const old = volume;
			volume = buildVolume();
			vol.value = volume.texture;
			old.dispose();

		}, 250 );

	} );

	// ---- GUI (tecla G) --------------------------------------------------

	const gui = new GUI( { title: 'Ajustes do fogo' } );
	gui.hide();

	const addTunables = ( folder, list ) => list.forEach( ( [ u, label, lo, hi ] ) => folder.add( u, 'value', lo, hi ).name( label ) );
	addTunables( gui.addFolder( 'Fluido' ), sim.tunables );
	addTunables( gui.addFolder( 'Aparência do gás' ), volumeTunables( volumeParams ) );

	{

		const f = gui.addFolder( 'Cena' );
		f.add( fireGI.gain, 'value', 0, 8 ).name( 'luz do fogo na cena' );
		f.add( renderer, 'toneMappingExposure', 0.2, 3 ).name( 'exposição' );
		f.add( post.haze, 'value', 0, 0.05 ).name( 'miragem de calor' );
		f.add( bloomPass.strength, 'value', 0, 2 ).name( 'bloom' );
		f.add( bloomPass.threshold, 'value', 0, 3 ).name( 'bloom limiar' );
		gui.folders.forEach( ( x ) => x.close() );

	}

	// ---- HUD ------------------------------------------------------------

	const statsEl = $( 'stats' );
	const qualityLinks = Object.keys( QUALITY_PRESETS ).map( ( k ) => `<a href="?q=${ k }" class="${ k === quality.name ? 'on' : '' }">${ k }</a>` ).join( '' );
	const cells = quality.grid[ 0 ] * quality.grid[ 1 ] * quality.grid[ 2 ];

	let fpsFrames = 0, fpsTime = 0, fps = 0, simSteps = 0, simRate = 0;

	function updateHUD( dt ) {

		fpsFrames ++; fpsTime += dt;

		if ( fpsTime >= 0.5 ) {

			fps = fpsFrames / fpsTime; simRate = simSteps / fpsTime;
			fpsFrames = 0; fpsTime = 0; simSteps = 0;
			statsEl.innerHTML = `<b>${ fps.toFixed( 0 )}</b> fps · sim <b>${ simRate.toFixed( 0 ) }</b> Hz · grade <b>${ quality.grid.join( '×' ) }</b> · <b>${ ( cells / 1e6 ).toFixed( 1 ) }M</b> voxels<br>${ gpuName ? 'GPU <b>' + gpuName + '</b><br>' : '' }qualidade ${ qualityLinks }`;

		}

		const left = 1 - rock.state.melted;
		$( 'barFill' ).style.width = ( left * 100 ).toFixed( 1 ) + '%';
		$( 'rockPct' ).textContent = Math.round( left * 100 ) + '%';
		$( 'rockTemp' ).textContent = Math.round( 20 + rock.state.peakHeat * 1380 ) + ' °C';

		if ( rock.state.done ) $( 'done' ).classList.add( 'show' );

	}

	// ---- loop -----------------------------------------------------------

	const timer = new THREE.Timer();
	const state = { fire: 0, mid: 0, impact: 0, time: 0, front: 0, tail: 0, impactOn: 0 };
	const REACH = MOUTH_POS.distanceTo( ROCK_CENTER );
	const tmp = new THREE.Vector3();
	let acc = 0, frame = 0, booted = false, paused = false;

	const flicker = ( t, s ) => 0.78 + 0.14 * Math.sin( t * 31.7 + s ) + 0.08 * Math.sin( t * 57.3 + s * 2.1 ) + 0.06 * Math.sin( t * 13.1 + s * 0.7 );

	// um passo de simulação: sempre 1/60 s, não importa a taxa do monitor
	function simStep() {

		const dt = SIM_DT;
		const su = sim.uniforms;
		const advance = su.jetSpeed.value * 0.6 * dt;

		// a frente do sopro avança até a pedra; ao soltar, o corte viaja atrás dela
		if ( input.fire ) {

			state.front = Math.min( REACH + 1.5, state.front + advance );
			state.tail = 0;

		} else if ( state.front > 0 ) {

			state.tail += advance;
			if ( state.tail >= state.front + 1 ) { state.front = 0; state.tail = 0; }

		}

		state.impactOn = ( state.front >= REACH - 0.4 && state.tail < REACH ) ? 1 : 0;
		state.impact += ( state.impactOn - state.impact ) * Math.min( 1, dt * 5 );

		su.jetFront.value = state.front;
		su.jetTail.value = state.tail;
		su.impact.value = state.impact * ( rock.state.done ? 0.2 : 1 );
		su.mouth.value.copy( dragon.mouthPosition );
		su.jetDir.value.copy( dragon.jetDirection );
		su.rockCenter.value.copy( rock.state.obstacleCenter );
		su.rockRadius.value = rock.state.obstacleRadius.x;
		su.rockSmoke.value = rock.state.smoke;

		// a pedra (calor por vértice na CPU) atualiza a 30 Hz
		if ( sim.frame % 2 === 0 ) rock.update( dt * 2, state.time, state.impact, dragon.jetDirection );
		sim.step();
		embers.update( dt, state.time, state.fire, state.impact, dragon.mouthPosition, dragon.jetDirection, rock.state );

		state.time += dt;
		simSteps ++;

	}

	function animate() {

		timer.update();
		if ( paused ) return;
		const rawDt = timer.getDelta();
		const realDt = Math.min( rawDt, 0.1 );
		const t = state.time;

		// envelope visual do sopro (mandíbula, luzes)
		const target = input.fire ? 1 : 0;
		state.fire += ( target - state.fire ) * Math.min( 1, realDt * ( target > state.fire ? 7 : 4 ) );
		state.mid += ( state.fire - state.mid ) * Math.min( 1, realDt * 5 );

		dragon.update( realDt, t, state.fire );

		acc = Math.min( acc + realDt, SIM_DT * 3 );
		let steps = 0;

		// no máximo um passo por frame: se a GPU não segura 60 fps, o fogo anda em câmera
		// lenta em vez de dobrar o custo e derrubar o fps de vez. Um segundo passo só
		// cobre um soluço isolado (frame de menos de 22 ms com tempo acumulado).
		const maxSteps = rawDt < 0.022 ? 2 : 1;

		while ( acc >= SIM_DT * 0.9 && steps < maxSteps ) {

			simStep();
			acc -= SIM_DT;
			steps ++;

		}

		if ( steps > 0 ) sim.relight();

		env.uniforms.scorch.value = Math.max( env.uniforms.scorch.value, Math.min( 1, rock.state.exposure * 0.06 ) );

		// luzes do fogo
		tmp.copy( ROCK_CENTER ).addScaledVector( dragon.jetDirection, - 1.9 );
		tmp.y += 0.9;
		impactLight.position.copy( tmp );
		impactLight.intensity = ( state.impact * 90 + rock.state.glow * 14 ) * flicker( t, 0 );
		jetLight.position.copy( dragon.mouthPosition ).addScaledVector( dragon.jetDirection, 3.0 );
		jetLight.position.y += 0.5;
		jetLight.intensity = state.mid * 55 * flicker( t, 2.3 );

		if ( input.cinematic ) {

			const a = t * 0.11;
			const r = 12.5 + Math.sin( t * 0.07 ) * 3.5;
			camera.position.set( - 0.6 + Math.cos( a ) * r, 3.8 + Math.sin( t * 0.09 ) * 1.6, Math.sin( a ) * r );

		}

		controls.update();
		post.time.value = t % 100;

		// o raymarch lê a profundidade do frame anterior, então só roda depois do primeiro render
		if ( frame > 0 ) volume.render( camera, frame );
		pipeline.render();
		frame ++;

		updateHUD( rawDt );

		if ( ! booted && frame > 2 ) {

			booted = true;
			$( 'boot' ).classList.add( 'gone' );

		}

	}

	renderer.setAnimationLoop( animate );

	// ---- depuração / testes ---------------------------------------------

	window.__fire = {
		sim, rock, dragon, input, setFire, state, renderer, camera, controls, post, quality, volumeParams, scene, studio,
		get volume() { return volume; },
		get fps() { return fps; },
		// tempo médio de cada etapa isolada, em ms (n execuções dividem uma espera da fila)
		async profile( n = 20 ) {

			const stages = {
				gas: () => renderer.compute( sim.gasPasses ),
				velocity: () => renderer.compute( sim.velPasses ),
				lights: () => sim.relight(),
				volume: () => volume.render( camera, frame ),
				post: () => pipeline.render()
			};
			const out = {};
			paused = true; // senão os frames normais entram no meio da medição

			for ( const [ name, run ] of Object.entries( stages ) ) {

				await device.queue.onSubmittedWorkDone();
				const t0 = performance.now();
				for ( let i = 0; i < n; i ++ ) run();
				await device.queue.onSubmittedWorkDone();
				out[ name ] = + ( ( performance.now() - t0 ) / n ).toFixed( 2 );

			}

			out.total = + Object.values( out ).reduce( ( a, b ) => a + b, 0 ).toFixed( 2 );
			paused = false;
			return out;

		}
	};

}

// ---- aviso de GPU integrada ---------------------------------------------

function showGpuNotice( kind, name ) {

	if ( kind === 'discrete' ) return;
	try {

		if ( localStorage.getItem( 'gpuNoticeDismissed' ) === kind ) return;

	} catch ( e ) { /* sem storage */ }

	const box = $( 'gpuNotice' );
	const isWin = /windows/i.test( navigator.userAgent );
	const browser = /edg\//i.test( navigator.userAgent ) ? 'edge' : 'chrome';
	$( 'gpuName' ).textContent = name || ( kind === 'software' ? 'renderização por software' : 'GPU integrada' );
	$( 'gpuWhat' ).textContent = kind === 'software' ? 'o navegador está desenhando sem placa de vídeo (por software).' : 'o navegador abriu na GPU integrada.';
	$( 'gpuFlag' ).textContent = browser + '://flags/#force-high-performance-gpu';
	$( 'gpuWin' ).style.display = isWin ? '' : 'none';
	box.classList.add( 'show' );

	$( 'gpuCopy' ).onclick = () => {

		navigator.clipboard?.writeText( $( 'gpuFlag' ).textContent );
		$( 'gpuCopy' ).textContent = 'copiado';

	};
	$( 'gpuClose' ).onclick = () => {

		box.classList.remove( 'show' );
		try { localStorage.setItem( 'gpuNoticeDismissed', kind ); } catch ( e ) { /* sem storage */ }

	};

}
