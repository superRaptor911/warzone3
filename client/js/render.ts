// Facade: the rendering implementation lives in gfx/ (PixiJS, WebGL).
// Kept so client code keeps importing Renderer/DrawView from './render.ts'.
export { Renderer } from './gfx/renderer.ts';
export type { DrawView } from './gfx/renderer.ts';
// Thrown by Renderer.create when the required world tilesheet cannot be loaded;
// main.ts distinguishes it from a generic WebGL failure.
export { MissingArtError } from './gfx/textures.ts';
