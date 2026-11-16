// ---------------------------------------------------------------
// Botão "GPU" + tutorial de como fazer o navegador usar a placa dedicada.
//
// No Windows o Chrome/Edge usam um único adaptador para o navegador inteiro
// e ignoram powerPreference, então a página só pode detectar e orientar.
// ---------------------------------------------------------------

const $ = ( id ) => document.getElementById( id );

const ua = navigator.userAgent;
const isWindows = /windows/i.test( ua );
const isEdge = /edg\//i.test( ua );
const scheme = isEdge ? 'edge' : 'chrome';

const texts = {
	flag: `${ scheme }://flags/#force-high-performance-gpu`,
	settings: `${ scheme }://settings/system`,
	gpuPage: `${ scheme }://gpu`,
	browserName: isEdge ? 'Microsoft Edge' : 'Google Chrome',
	exe: isEdge ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
};

const STATUS = {
	discrete: ( n ) => `Em uso agora: <b>${ n }</b>. Placa dedicada ativa, nada a fazer.`,
	integrated: ( n ) => `Em uso agora: <b>${ n }</b>, a GPU integrada. A qualidade foi reduzida para rodar liso.`,
	software: ( n ) => `Em uso agora: <b>${ n || 'renderização por software' }</b>. O navegador está sem aceleração de vídeo.`,
	none: () => 'Este navegador não ofereceu WebGPU. Use Chrome ou Edge atualizados e confira a aceleração por hardware.'
};

let currentKind = 'none';
const esc = ( s ) => String( s || '' ).replace( /[&<>"]/g, ( c ) => '&#' + c.charCodeAt( 0 ) + ';' );

export const isGpuHelpOpen = () => $( 'gpuHelp' ).classList.contains( 'show' );

function openHelp() {

	$( 'gpuNotice' ).classList.remove( 'show' );
	$( 'gpuHelp' ).classList.add( 'show' );
	$( 'gpuHelp' ).querySelector( '.panel' ).scrollTop = 0;

}

function closeHelp() {

	$( 'gpuHelp' ).classList.remove( 'show' );

}

export function setupGpuHelp() {

	const help = $( 'gpuHelp' );

	help.querySelectorAll( '[data-text]' ).forEach( ( el ) => el.textContent = texts[ el.dataset.text ] );
	if ( ! isWindows ) help.querySelectorAll( '[data-only="windows"]' ).forEach( ( el ) => el.remove() );

	help.querySelectorAll( '[data-copy]' ).forEach( ( btn ) => btn.addEventListener( 'click', async () => {

		try {

			await navigator.clipboard.writeText( texts[ btn.dataset.copy ] );
			btn.textContent = 'copiado ✓';

		} catch ( e ) {

			btn.textContent = 'selecione e copie';

		}

		setTimeout( () => btn.textContent = 'copiar', 1800 );

	} ) );

	help.querySelectorAll( '[data-close]' ).forEach( ( b ) => b.addEventListener( 'click', closeHelp ) );
	help.addEventListener( 'click', ( e ) => {

		if ( e.target === help ) closeHelp();

	} );

	// o popup engole o teclado: espaço não cospe fogo com ele aberto
	window.addEventListener( 'keydown', ( e ) => {

		if ( ! isGpuHelpOpen() ) return;
		if ( e.code === 'Escape' ) closeHelp();
		e.stopImmediatePropagation();

	}, true );

	$( 'gpuBtn' ).addEventListener( 'click', openHelp );
	$( 'gpuNoticeHelp' ).addEventListener( 'click', openHelp );
	$( 'gpuNoticeClose' ).addEventListener( 'click', () => {

		$( 'gpuNotice' ).classList.remove( 'show' );
		try { localStorage.setItem( 'gpuNoticeDismissed', currentKind ); } catch ( e ) { /* sem storage */ }

	} );

}

// kind: discrete | integrated | software | none
export function setGpu( kind, name ) {

	currentKind = kind;
	$( 'gpuBtn' ).className = kind;
	$( 'gpuStatus' ).className = 'status ' + kind;
	$( 'gpuStatusText' ).innerHTML = STATUS[ kind ]( esc( name ) );

	if ( kind === 'discrete' ) return;

	try {

		if ( localStorage.getItem( 'gpuNoticeDismissed' ) === kind ) return;

	} catch ( e ) { /* sem storage */ }

	$( 'gpuNoticeTitle' ).textContent = kind === 'none' ? 'WebGPU indisponível' : kind === 'software' ? 'Sem placa de vídeo' : 'Rodando na GPU integrada';
	$( 'gpuNoticeText' ).textContent = kind === 'none' ? 'O simulador precisa de WebGPU.'
		: `${ name || 'GPU' }. A qualidade foi reduzida. Se o computador tiver placa de vídeo dedicada, dá para ligá-la em um minuto.`;
	$( 'gpuNotice' ).classList.add( 'show' );

}
