import Program from "nanogl/program";
import Fbo from "nanogl/fbo";
import GLArrayBuffer from "nanogl/arraybuffer";
import PixelFormats from "nanogl-pf";
import main_frag from "./glsl/templates/main.frag";
import main_vert from "./glsl/templates/main.vert";
import { EffectDependency } from "./effects/base-effect";
import { isWebgl2 } from "nanogl/types";
export default class Post {
  constructor(gl, mipmap = false) {
    this.gl = gl;
    this._effects = [];
    this._flags = 0;
    this._shaderInvalid = true;
    this.renderWidth = 1;
    this.renderHeight = 1;
    this.bufferWidth = 1;
    this.bufferHeight = 1;
    this.enabled = true;
    this.mipmap = mipmap;
    this.float_texture_ext = gl.getExtension("OES_texture_float");
    this.halfFloat = gl.getExtension("OES_texture_half_float");
    this.float_texture_ext_l = gl.getExtension("OES_texture_half_float_linear");
    this.halfFloat_l = gl.getExtension("OES_texture_float_linear");
    this.color_buffer_float = gl.getExtension("EXT_color_buffer_float");
    this.hasDepthTexture = PixelFormats.getInstance(gl).hasDepthTexture();
    this.mainFbo = this.genFbo();
    this.mainColor = this.mainFbo.getColor(0);
    if (this.mipmap) {
      this.mainColor.bind();
      gl.generateMipmap(gl.TEXTURE_2D);
      const err = gl.getError();
      if (err) {
        this.mipmap = false;
        this.mainFbo.dispose();
        this.mainFbo = this.genFbo();
        this.mainColor = this.mainFbo.getColor(0);
      }
    }
    this.mainColor.setFilter(false, this.mipmap, false);
    this.prg = new Program(gl);
    const fsData = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    this.fsPlane = new GLArrayBuffer(gl, fsData);
    this.fsPlane.attrib("aTexCoord0", 2, gl.FLOAT);
  }
  dispose() {
    this.mainFbo.dispose();
    this.fsPlane.dispose();
    this.prg.dispose();
  }
  _needDepth() {
    return (this._flags & EffectDependency.DEPTH) !== 0;
  }
  _needLinear() {
    return (this._flags & EffectDependency.LINEAR) !== 0;
  }
  genFbo() {
    const gl = this.gl;
    const pf = PixelFormats.getInstance(gl);
    const ctxAttribs = gl.getContextAttributes();
    const configs = [pf.RGB16F, pf.RGBA16F, pf.RGB32F, pf.RGBA32F, pf.RGB8];
    if (isWebgl2(gl)) {
    }
    const cfg = pf.getRenderableFormat(configs);
    const fbo = new Fbo(gl);
    fbo.bind();
    fbo.attachColor(cfg.format, cfg.type, cfg.internal);
    fbo.attachDepth(ctxAttribs.depth, ctxAttribs.stencil, this.hasDepthTexture);
    fbo.resize(4, 4);
    const color = fbo.getColor(0);
    color.bind();
    color.clamp();
    if (this.hasDepthTexture) {
      const depth = fbo.getDepth();
      depth.bind();
      depth.clamp();
      depth.setFilter(false, false, false);
    }
    return fbo;
  }
  add(effect) {
    if (this._effects.indexOf(effect) === -1) {
      this._effects.push(effect);
      effect._init(this);
      effect.resize(this.renderWidth, this.renderHeight);
      this._flags |= effect._flags;
      this._shaderInvalid = true;
    }
  }
  remove(effect) {
    const i = this._effects.indexOf(effect);
    if (i > -1) {
      this._effects.splice(i, 1);
      effect.release();
      effect.post = null;
      this._shaderInvalid = true;
      if (effect._flags !== 0) {
        this._flags = 0;
        for (var j = 0; j < this._effects.length; j++) {
          this._flags |= effect._flags;
        }
      }
    }
  }
  resize(w, h) {
    this.bufferWidth = w;
    this.bufferHeight = h;
    this.mainFbo.resize(this.bufferWidth, this.bufferHeight);
    for (var i = 0; i < this._effects.length; i++) {
      this._effects[i].resize(w, h);
    }
  }
  preRender(w, h) {
    this.renderWidth = w;
    this.renderHeight = h;
    if (this.enabled) {
      const bufferWidth = this.mipmap ? nextPOT(w) : w;
      const bufferHeight = this.mipmap ? nextPOT(h) : h;
      if (
        this.bufferWidth !== bufferWidth ||
        this.bufferHeight !== bufferHeight
      ) {
        this.resize(bufferWidth, bufferHeight);
      }
    }
  }
  needDepthPass() {
    return this.enabled && this._needDepth() && !this.hasDepthTexture;
  }
  bindColor() {
    const gl = this.gl;
    if (this.enabled) {
      this.mainFbo.bind();
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, this.renderWidth, this.renderHeight);
    this.mainFbo.clear();
  }
  render(toFbo) {
    if (!this.enabled) {
      return;
    }
    const gl = this.gl;
    this.mainColor.bind();
    if (this.mipmap) {
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    for (var i = 0; i < this._effects.length; i++) {
      this._effects[i].preRender();
    }
    if (toFbo !== undefined) {
      toFbo.resize(this.renderWidth, this.renderHeight);
      toFbo.bind();
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, this.renderWidth, this.renderHeight);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this._shaderInvalid) {
      this.buildProgram();
    }
    this.prg.use();
    for (var i = 0; i < this._effects.length; i++) {
      this._effects[i].setupProgram(this.prg);
    }
    this.prg.tInput(this.mainColor);
    if (this._needDepth()) {
      if (this.hasDepthTexture) this.prg.tDepth(this.mainFbo.getDepth());
      else throw "no depth texture";
    }
    this.fillScreen(this.prg);
  }
  fillScreen(prg, fullframe = false) {
    if (fullframe === true) {
      if (prg && prg.uViewportScale) prg.uViewportScale(1, 1);
    } else {
      if (prg && prg.uViewportScale)
        prg.uViewportScale(
          this.renderWidth / this.bufferWidth,
          this.renderHeight / this.bufferHeight
        );
    }
    this.fsPlane.attribPointer(prg);
    this.fsPlane.drawTriangleStrip();
  }
  buildProgram() {
    var codeList = [],
      precodeList = [];
    var effects = this._effects;
    for (var i = 0; i < effects.length; i++) {
      effects[i].genCode(precodeList, codeList);
    }
    const code = codeList.join("\n");
    const precode = precodeList.join("\n");
    var frag = main_frag({
      code: code,
      precode: precode,
    });
    var vert = main_vert();
    var depthTex = this._needDepth() && this.hasDepthTexture;
    var defs = "";
    if (isWebgl2(this.gl)) {
      defs += "#version 300 es\n";
    }
    defs += "precision highp float;\n";
    defs += "#define NEED_DEPTH " + +this._needDepth() + "\n";
    defs += "#define TEXTURE_DEPTH " + +depthTex + "\n";
    this.prg.compile(vert, frag, defs);
    this._shaderInvalid = false;
    this.mainColor.bind();
    this.mainColor.setFilter(this._needLinear(), this.mipmap, false);
  }
}
const MAX_POT = 4096;
function nextPOT(n) {
  var p = 1;
  while (p < n) p <<= 1;
  if (p > MAX_POT) p = MAX_POT;
  return p;
}
