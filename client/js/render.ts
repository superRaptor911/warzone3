// Facade: the rendering implementation lives in gfx/ (PixiJS, WebGL).
// Kept so client code keeps importing Renderer/DrawView from './render.ts'.
export { Renderer } from './gfx/renderer.ts';
export type { DrawView } from './gfx/renderer.ts';
