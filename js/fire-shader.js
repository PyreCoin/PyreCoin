// WebGL fire shader. Self-contained — no exports, runs on import.
(function(){
  const cv=document.getElementById('fireCanvas');
  const gl=cv.getContext('webgl2');
  if(!gl)return;

  function resize(){cv.width=innerWidth;cv.height=innerHeight;gl.viewport(0,0,cv.width,cv.height);}
  resize();window.addEventListener('resize',resize);

  const VS=`#version 300 es
  precision highp float;
  in vec2 p;
  void main(){gl_Position=vec4(p,0,1);}`;

  const FS=`#version 300 es
  precision highp float;
  uniform float T;
  uniform vec2 R;
  out vec4 O;

  // ─────────────────────────────────────────────────────────────────────
  // FIRE SHADER — built on 3D simplex noise where the third axis is time.
  //
  // Why this approach (and not what I had before):
  //   2D noise that scrolls only translates a fixed pattern. Two frames
  //   one second apart show the same noise field shifted up — visually
  //   it loops. 3D noise with time as the third axis means the noise
  //   field itself ANIMATES: features mutate, dissolve, reform. That
  //   non-periodic mutation is what makes real fire look alive.
  //
  // Pattern from Will Doenlen / Lygia / Inigo Quilez:
  //   p = vec3(x, y - time*v, time)
  //   q = vec3(fbm(p + (0,0,t)), fbm(p + (0.3,1.3,t)), t)
  //   col = fbm(p + 0.5*q) * intensity * fire_color
  //
  // Noise function: Ashima Arts / Gustavson MIT-licensed 3D simplex.
  // This is the standard portable GLSL simplex implementation used in
  // three.js, ShaderToy, and pretty much every shader codebase.
  //
  // References:
  //   Will Doenlen:  https://www.willdoenlen.com/blog/realistic-fire-shader
  //   IQ flame:      https://www.shadertoy.com/view/MdX3zr
  //   Lygia fbm/snoise: https://github.com/patriciogonzalezvivo/lygia
  //   Ashima noise:  https://github.com/stegu/webgl-noise (MIT)
  // ─────────────────────────────────────────────────────────────────────

  vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}

  // 3D simplex noise — Stefan Gustavson & Ian McEwan, MIT
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g  = step(x0.yzx, x0.xyz);
    vec3 l  = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
                i.z + vec4(0.0, i1.z, i2.z, 1.0))
              + i.y + vec4(0.0, i1.y, i2.y, 1.0))
              + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3  ns = n_ * D.wyz - D.xzx;

    vec4 j  = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x  = x_ * ns.x + ns.yyyy;
    vec4 y  = y_ * ns.x + ns.yyyy;
    vec4 h  = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  // 5-octave 3D FBM (returns ~[-1, 1])
  float fbm3(vec3 p){
    float v = 0.0;
    float a = 0.5;
    for(int i = 0; i < 5; i++){
      v += a * snoise(p);
      p *= 2.0;
      a *= 0.5;
    }
    return v;
  }

  // Quick 2D hash for spark scatter
  float h2(vec2 p){return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);}

  void main(){
    vec2 uv = gl_FragCoord.xy / R;

    // Aspect-corrected centered coords. fc.x in [-aspect/2, +aspect/2].
    vec2 fc = vec2((uv.x - 0.5) * R.x / R.y, uv.y);

    // ── 3D NOISE COORDINATE ──
    // x: aspect-corrected screen
    // y: scrolling UPWARD over time (negative coefficient on T)
    // z: time itself — this is what makes the field MUTATE not just shift
    float t  = T * 0.5;
    vec3  p  = vec3(fc.x * 2.0, fc.y * 1.5 - T * 1.6, t);

    // ── DOMAIN WARP ──
    // Two FBM channels, each evolving with time, used to displace p
    // before the final FBM. This produces irregular, non-translational
    // motion — features curl, fork, dissolve.
    vec3 q = vec3(
      fbm3(p + vec3(0.0, 0.0, t)),
      fbm3(p + vec3(5.7, 1.3, t * 1.3)),
      t
    );
    float n = fbm3(p + q * 0.6);
    n = 0.5 + 0.5 * n; // normalize to [0, 1]

    // ── FLAME ENVELOPE ──
    // Vertical falloff: bright at base, dark at top.
    float gradient = pow(max(0.0, 1.0 - uv.y), 1.6) * 4.5;

    // Soft horizontal column taper.
    float column = 1.0 - smoothstep(0.32, 0.85, abs(fc.x));

    // Slight bottom-edge fade (avoid a hard line where the fire ends).
    float bottomFade = smoothstep(0.0, 0.04, uv.y);

    float intensity = n * gradient * column * bottomFade;

    // ── COLOR (IQ-style: red baseline, green cubed, blue quartic) ──
    // As intensity rises through n: black → deep red → orange → yellow → white.
    // Multiplying by intensity (the spatial mask × noise) gives heat
    // distribution; the inner powers shape the temperature gradient.
    vec3 col = intensity * vec3(2.0 * n, 2.0 * n * n * n, n * n * n * n);

    // ── HOT-CORE LIFT ──
    // Saturated red glow around the brightest cores. Adds depth.
    // (Replaced pow(c, 2.0) with c*c — explicit multiply is reliably
    // cheaper than a generic pow() call on most GPU drivers.)
    float c    = max(0.0, intensity - 0.55);
    float core = c * c * 1.4;
    col += vec3(0.7, 0.08, 0.0) * core;

    // ── SPARKS ──
    // Small bright dots that always rise. Per-spark cycle period varies
    // by seed so they don't march in lockstep.
    //
    // Hot path optimization: the smoothstep(sz, 0, dist) factor is zero
    // whenever dist > sz, which is true for ~99% of (pixel, spark) pairs
    // since each spark is a few-pixel dot in a multi-million-pixel frame.
    // We compute the cheap squared distance, compare to the squared size,
    // and 'continue' — skipping the sqrt + smoothstep + pow + sin + final
    // multiply for the vast majority of iterations. Mathematically
    // identical to the original (skipped iterations contributed 0).
    for(int i = 0; i < 40; i++){
      float fi    = float(i);
      float seed  = h2(vec2(fi * 0.73, fi * 0.31 + 4.1));
      float seed2 = h2(vec2(fi * 0.41 + 1.9, fi * 0.87));
      float seed3 = h2(vec2(fi * 1.13 + 7.7, fi * 0.59));
      float rate  = 0.32 + seed3 * 0.50;
      float life  = fract(T * rate + seed);
      float x0    = (seed - 0.5) * 0.78;
      float xd    = sin(life * 7.0 + fi * 2.1) * seed2 * 0.14 * (1.0 - life);
      float yPos  = (1.0 - pow(1.0 - life, 1.45)) * (1.1 + seed3 * 0.4);
      float dx    = (fc.x - (x0 + xd)) * 1.4;
      float dy    = uv.y - yPos;
      float distSq = dx*dx + dy*dy;
      float sz    = 0.0033 * (0.4 + seed * 0.6);
      if (distSq > sz * sz) continue;
      float dist  = sqrt(distSq);
      float bright= smoothstep(sz, 0.0, dist) * pow(1.0 - life, 1.2) * 2.0;
      float flick = 0.55 + 0.45 * sin(T * (18.0 + seed * 8.0) + fi * 4.3);
      col += vec3(1.0, 0.7 + seed * 0.3, 0.15 + seed * 0.2) * (bright * flick) * 0.85;
    }

    O = vec4(col, 1.0);
  }`;

  function mksh(t,s){
    const sh=gl.createShader(t);
    gl.shaderSource(sh,s);gl.compileShader(sh);
    if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))console.error(gl.getShaderInfoLog(sh));
    return sh;
  }
  const pr=gl.createProgram();
  gl.attachShader(pr,mksh(gl.VERTEX_SHADER,VS));
  gl.attachShader(pr,mksh(gl.FRAGMENT_SHADER,FS));
  gl.linkProgram(pr);gl.useProgram(pr);

  const bf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,bf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const al=gl.getAttribLocation(pr,'p');
  gl.enableVertexAttribArray(al);
  gl.vertexAttribPointer(al,2,gl.FLOAT,false,0,0);

  const uT=gl.getUniformLocation(pr,'T');
  const uR=gl.getUniformLocation(pr,'R');
  // Blending intentionally NOT enabled: the fragment shader writes
  // vec4(col, 1.0) to every pixel, and the framebuffer is cleared to
  // (0,0,0,1) at the start of each frame. Under SRC_ALPHA/ONE blending,
  // the math reduces to `final = src + 0 = src` — identical to no
  // blending — but with an extra framebuffer read per pixel. Disabling
  // it is free FPS on bandwidth-bound GPUs.

  const t0=performance.now();
  (function frame(){
    const t=(performance.now()-t0)/1000;
    gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uT,t);gl.uniform2f(uR,cv.width,cv.height);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    requestAnimationFrame(frame);
  })();
})();
