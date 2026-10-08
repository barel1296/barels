import './styles.css';
import { Game } from './game/Game';

function fail(msg: string): void {
  const ui = document.getElementById('ui')!;
  ui.innerHTML = `<div class="screen"><div class="panel narrow"><h2>Cannot start</h2><p class="subtitle">${msg}</p></div></div>`;
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

if (!webglAvailable()) {
  fail('This game needs WebGL 2. Please use an up-to-date browser such as Chrome, Edge, Firefox or Safari 15+.');
} else {
  const game = new Game(
    document.getElementById('scene') as HTMLCanvasElement,
    document.getElementById('hud') as HTMLCanvasElement,
    document.getElementById('ui') as HTMLElement,
  );
  (window as unknown as { __game: unknown }).__game = game.debugApi();
  game.start().catch((e) => {
    console.error(e);
    fail(`Something went wrong while loading: ${String(e)}`);
  });
}
