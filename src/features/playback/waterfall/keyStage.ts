import { KEY_FRAGMENT_SHADER, KEY_VERTEX_SHADER, POST_FRAGMENT_SHADER, SCREEN_VERTEX_SHADER } from './keyShaders';
import type { Rgb } from './waterfallPalette';

const RGB_MAX = 255;
/** The shader lights at most this many keys at once, the brightest ones. */
const MAX_LAMPS = 6;
/** One lamp is x, light, attack, spare. */
const LAMP_FLOATS = 4;
/** The black keys that can cast a shadow on the caps; a full piano has 36. */
const MAX_BLOCKERS = 37;
/** The bright part and its two blur passes run at a quarter of the canvas size. */
const GLOW_SCALE = 0.25;
const MAX_SAMPLES = 4;
/** One instance of a key is x, down, black, pitch, r, g, b, dye. */
const INSTANCE_FLOATS = 8;
const VERTEX_FLOATS = 6;
const FLOAT_BYTES = 4;
/** How far the lit keys of a chord reach each other: the chord adds to the first strike's onset flash. */
const CHORD_REACH = 5.2;
const ONSET_WEIGHT = 0.81;
const ONSET_ALONE = 0.38;
/** How far a black key's cast shadow can reach, and how high its top stands, in white-key widths. */
const BLACK_LENGTH = 3.06;
const BLACK_TOP = 0.56;
const BLACK_TRAVEL = 0.2;
/** A white key's and a black key's outline: half width, length, top height, base height, bevel. */
const WHITE_SHAPE = { half: 0.488, length: 5, top: 0, base: -0.4, bevel: 0.018 } as const;
const BLACK_SHAPE = { half: 0.295, length: BLACK_LENGTH, top: BLACK_TOP, base: 0.026, bevel: 0.045 } as const;
/** A key's height drawn per unit of its length. */
const HEIGHT_PER_DEPTH = 0.89;

export interface StageKey {
  midi: number;
  black: boolean;
  /** the key's centre along the keyboard, in plane units */
  x: number;
}

/** A key that is lit or pressed: where it sits on screen, how bright it is, how far it is down, the flash of its attack, and its voice colour. */
export interface KeyLight {
  midi: number;
  x: number;
  light: number;
  press: number;
  onset: number;
  rgb: Rgb;
}

/** What the keyboard is drawn over and with: the 2D scene as the backdrop, and the geometry of the key bed. */
export interface KeyStageFrame {
  sheet: HTMLCanvasElement;
  width: number;
  height: number;
  rail: number;
  depth: number;
  pitch: number;
  keys: StageKey[];
  /** the colour of the light under the keyboard along its width, 25 stops of r, g, b */
  underField: Float32Array;
}

interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  depth: WebGLRenderbuffer | null;
}

interface MultisampleTarget {
  framebuffer: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depth: WebGLRenderbuffer;
}

/** The keyboard: WebGL2 keys over the 2D scene, with the bright part of the picture bloomed back over it. */
export class KeyStage {
  private readonly gl: WebGL2RenderingContext;
  private readonly post: WebGLProgram;
  private readonly mesh: WebGLProgram;
  private readonly screenArray: WebGLVertexArrayObject;
  private readonly keyArray: WebGLVertexArrayObject;
  private readonly shape: WebGLBuffer;
  private readonly instances: WebGLBuffer;
  private readonly source: WebGLTexture;
  private readonly ranges: [number, number][] = [];
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private targets: RenderTarget[] = [];
  private multisample: MultisampleTarget | null = null;
  private size = '';
  private sheetSize = '';

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL 2 is unavailable');
    this.gl = gl;
    this.post = this.program(SCREEN_VERTEX_SHADER, POST_FRAGMENT_SHADER);
    this.mesh = this.program(KEY_VERTEX_SHADER, KEY_FRAGMENT_SHADER);
    this.screenArray = gl.createVertexArray();
    this.keyArray = gl.createVertexArray();
    gl.bindVertexArray(this.keyArray);
    this.shape = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shape);
    for (let attribute = 0; attribute < 2; attribute++) {
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, VERTEX_FLOATS * FLOAT_BYTES, attribute * 3 * FLOAT_BYTES);
    }
    this.instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    for (let attribute = 0; attribute < 2; attribute++) {
      gl.enableVertexAttribArray(attribute + 2);
      gl.vertexAttribPointer(attribute + 2, 4, gl.FLOAT, false, INSTANCE_FLOATS * FLOAT_BYTES, attribute * 4 * FLOAT_BYTES);
      gl.vertexAttribDivisor(attribute + 2, 1);
    }
    const vertices: number[] = [];
    for (const shape of [WHITE_SHAPE, BLACK_SHAPE]) {
      const black = shape === BLACK_SHAPE;
      const first = vertices.length / VERTEX_FLOATS;
      const { half, length, top, base, bevel } = shape;
      const outline = (h: number, l: number, z: number): number[][] => [[-h, 0, z], [h, 0, z], [h, l - bevel, z], [h - bevel, l, z], [-h + bevel, l, z], [-h, l - bevel, z]];
      const upper = outline(half - bevel, length - bevel, top);
      const middle = outline(half, length, top - bevel);
      const lower = outline(half, length, base);
      const triangle = (a: number[], b: number[], c: number[], shade: number, k: number) => {
        for (const vertex of [a, b, c]) vertices.push(...vertex, shade, k, k);
      };
      for (let i = 1; i < 5; i++) triangle(upper[0], upper[i], upper[i + 1], black ? 0.095 : 0.375, 1);
      for (let i = 0; i < 6; i++) {
        const j = (i + 1) % 6;
        const bands: [number[][], number[][], number, number][] = [
          [upper, middle, black ? (i === 5 ? 0.205 : 0.16) : 0.47, 0.91],
          [middle, lower, black ? 0.058 : 0.195, 0.63],
        ];
        for (const [above, below, shade, k] of bands) {
          triangle(above[i], above[j], below[j], shade, k);
          triangle(above[i], below[j], below[i], shade, k);
        }
      }
      this.ranges.push([first, vertices.length / VERTEX_FLOATS - first]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shape);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    this.source = this.texture();
  }

  /** Frees everything the stage holds on the GPU; the stage cannot draw afterwards. */
  dispose(): void {
    const gl = this.gl;
    this.releaseTargets();
    gl.deleteTexture(this.source);
    gl.deleteBuffer(this.shape);
    gl.deleteBuffer(this.instances);
    gl.deleteVertexArray(this.screenArray);
    gl.deleteVertexArray(this.keyArray);
    gl.deleteProgram(this.post);
    gl.deleteProgram(this.mesh);
  }

  draw(frame: KeyStageFrame, lights: KeyLight[]): void {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    this.resize(width, height);
    const [full, quarter, blurred] = this.targets;
    const multisample = this.multisample;
    if (!multisample) return;
    const seam = 1 - frame.rail / frame.height;
    const pass = (target: { framebuffer: WebGLFramebuffer; width: number; height: number } | null, texture: WebGLTexture, mode: number, axisX = 0, axisY = 0, glow = texture) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
      gl.viewport(0, 0, target ? target.width : width, target ? target.height : height);
      gl.useProgram(this.post);
      gl.bindVertexArray(this.screenArray);
      gl.disable(gl.DEPTH_TEST);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, glow);
      gl.uniform1i(this.uniform(this.post, 'scene'), 0);
      gl.uniform1i(this.uniform(this.post, 'glow'), 1);
      gl.uniform1f(this.uniform(this.post, 'seam'), seam);
      gl.uniform1i(this.uniform(this.post, 'pass'), mode);
      gl.uniform2f(this.uniform(this.post, 'axis'), axisX, axisY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    // The 2D scene is the backdrop the keys are drawn over.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // The texture is allocated when the picture changes size and only refilled on every other frame.
    if (this.sheetSize === `${frame.sheet.width}x${frame.sheet.height}`) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.sheet);
    else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.sheet);
      this.sheetSize = `${frame.sheet.width}x${frame.sheet.height}`;
    }
    pass({ framebuffer: multisample.framebuffer, width, height }, this.source, 0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.mesh);
    gl.bindVertexArray(this.keyArray);
    const uniform = (name: string) => this.uniform(this.mesh, name);
    const stepY = frame.depth / WHITE_SHAPE.length;
    gl.uniform4f(uniform('camera'), frame.width, frame.height, frame.pitch, 0);
    gl.uniform4f(uniform('stage'), frame.rail + 0.04, stepY, stepY * HEIGHT_PER_DEPTH, 0);
    const byMidi = new Map(frame.keys.map((key) => [key.midi, key]));
    const brightest = lights.slice().sort((a, b) => b.light - a.light).slice(0, MAX_LAMPS);
    const lamps = new Float32Array(MAX_LAMPS * LAMP_FLOATS);
    const colors = new Float32Array(MAX_LAMPS * 3);
    brightest.forEach((lamp, index) => {
      const chord = brightest.reduce((sum, other) => sum + (other === lamp ? 0 : Math.min(1, other.light) * Math.exp(-Math.abs(other.x - lamp.x) / (frame.pitch * CHORD_REACH))), 0);
      const attack = ONSET_WEIGHT * lamp.onset * (ONSET_ALONE + (1 - ONSET_ALONE) * Math.min(1, chord));
      const key = byMidi.get(lamp.midi);
      lamps.set([key ? key.x / frame.pitch : 0, lamp.light, attack, 0], LAMP_FLOATS * index);
      colors.set(lamp.rgb.map((channel) => channel / RGB_MAX), 3 * index);
    });
    gl.uniform4fv(uniform('lamps[0]'), lamps);
    gl.uniform3fv(uniform('colors[0]'), colors);
    gl.uniform1i(uniform('count'), brightest.length);
    gl.uniform3fv(uniform('underLight[0]'), frame.underField);
    gl.uniform1f(uniform('boardWidth'), frame.width / frame.pitch);
    const held = new Map(lights.map((light) => [light.midi, light]));
    const blockers = new Float32Array(MAX_BLOCKERS * 4);
    let blockerCount = 0;
    for (const key of frame.keys) {
      if (!key.black) continue;
      const down = held.get(key.midi)?.press ?? 0;
      blockers.set([key.x / frame.pitch, BLACK_LENGTH, BLACK_TOP - down * BLACK_TRAVEL, 0], 4 * blockerCount++);
    }
    gl.uniform4fv(uniform('blockers[0]'), blockers);
    gl.uniform1i(uniform('blockerCount'), blockerCount);
    for (const type of [0, 1]) {
      const list: number[] = [];
      for (const key of frame.keys) {
        if (Number(key.black) !== type) continue;
        const light = held.get(key.midi);
        const press = light?.press ?? 0;
        list.push(key.x / frame.pitch, press, type, key.midi, ...(light ? light.rgb : [0, 0, 0]).map((channel) => channel / RGB_MAX), Math.min(1, press * 0.98 + (light?.light ?? 0) * 0.08));
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(list), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, this.ranges[type][0], this.ranges[type][1], list.length / INSTANCE_FLOATS);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, multisample.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, full.framebuffer);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    pass(quarter, full.texture, 1);
    pass(blurred, quarter.texture, 2, 1 / quarter.width, 0);
    pass(quarter, blurred.texture, 2, 0, 1 / blurred.height);
    pass(null, full.texture, 3, 0, 0, quarter.texture);
  }

  private program(vertex: string, fragment: string): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Cannot create a shader');
      gl.shaderSource(shader, `#version 300 es\nprecision highp float;\n${source}`);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader failed to compile');
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program failed to link');
    return program;
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.LINEAR);
    for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    const key = `${program === this.post ? 'post' : 'mesh'}:${name}`;
    if (!this.uniforms.has(key)) this.uniforms.set(key, this.gl.getUniformLocation(program, name));
    return this.uniforms.get(key) ?? null;
  }

  private releaseTargets(): void {
    const gl = this.gl;
    if (this.multisample) {
      gl.deleteFramebuffer(this.multisample.framebuffer);
      gl.deleteRenderbuffer(this.multisample.color);
      gl.deleteRenderbuffer(this.multisample.depth);
      this.multisample = null;
    }
    for (const target of this.targets) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
      if (target.depth) gl.deleteRenderbuffer(target.depth);
    }
    this.targets = [];
  }

  private resize(width: number, height: number): void {
    if (this.size === `${width}x${height}`) return;
    this.size = `${width}x${height}`;
    const gl = this.gl;
    this.releaseTargets();
    for (const scale of [1, GLOW_SCALE, GLOW_SCALE]) {
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      const texture = this.texture();
      const framebuffer = gl.createFramebuffer();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, targetWidth, targetHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      let depth: WebGLRenderbuffer | null = null;
      if (scale === 1) {
        depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, targetWidth, targetHeight);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      }
      this.targets.push({ framebuffer, texture, width: targetWidth, height: targetHeight, depth });
    }
    const samples = Math.min(MAX_SAMPLES, gl.getParameter(gl.MAX_SAMPLES) as number);
    const framebuffer = gl.createFramebuffer();
    const color = gl.createRenderbuffer();
    const depth = gl.createRenderbuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    for (const [renderbuffer, format, attachment] of [[color, gl.RGBA8, gl.COLOR_ATTACHMENT0], [depth, gl.DEPTH_COMPONENT16, gl.DEPTH_ATTACHMENT]] as const) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, renderbuffer);
    }
    this.multisample = { framebuffer, color, depth };
  }
}
