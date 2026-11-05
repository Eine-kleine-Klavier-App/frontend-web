// GLSL ES 3.00 for the keyboard. All key geometry is in white-key widths: X runs along the
// keyboard, Y towards the player, Z is the height above the white caps. The numeric constants in
// the shaders are tuned optics (how light spills over the caps, how the lip stays dark), not
// layout, so they stay as measured.

/** One triangle that covers the screen; the post-processing passes draw it. */
export const SCREEN_VERTEX_SHADER = `
out vec2 uv;
void main() {
  vec2 q = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = q;
  gl_Position = vec4(q * 2. - 1., 0., 1.);
}`;

/** pass 0 copies the scene; 1 keeps its bright part; 2 blurs along `axis`; 3 adds the glow below the seam. */
export const POST_FRAGMENT_SHADER = `
in vec2 uv;
out vec4 pixel;
uniform sampler2D scene, glow;
uniform int pass;
uniform vec2 axis;
uniform float seam;
void main() {
  vec3 a = texture(scene, uv).rgb;
  if (pass == 1) {
    float l = dot(a, vec3(.22, .63, .15));
    a *= smoothstep(.50, .86, l);
  }
  if (pass == 2) {
    a = a * .24;
    for (int i = 1; i <= 3; i++) {
      vec2 q = axis * float(i);
      float w = i == 1 ? .22 : (i == 2 ? .12 : .04);
      a += (texture(scene, uv + q).rgb + texture(scene, uv - q).rgb) * w;
    }
  }
  if (pass == 3) {
    vec3 b = texture(glow, uv).rgb;
    a += b * (1. - a) * .72 * step(seam, uv.y);
  }
  pixel = vec4(a, 1.);
}`;

/** Places an instance of a key: pitch along X, tilted about its back edge as it goes down. */
export const KEY_VERTEX_SHADER = `
layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 material;
layout(location = 2) in vec4 instance;
layout(location = 3) in vec4 tint;
uniform vec4 camera;
uniform vec4 stage;
out vec3 point;
out vec3 mat;
flat out vec4 key;
flat out vec4 ink;
void main() {
  float black = instance.z, down = instance.y;
  float a = -down * mix(.061, .082, black);
  vec3 p = pos;
  p.x += instance.x;
  p.y = pos.y * cos(a) - pos.z * sin(a) + black * .5;
  p.z = pos.y * sin(a) + pos.z * cos(a);
  float sy = stage.x + p.y * stage.y - p.z * stage.z;
  float sx = p.x * camera.z;
  float depth = clamp(.65 - p.z * .12 - p.y * .024, 0., .98);
  gl_Position = vec4(sx / camera.x * 2. - 1., 1. - sy / camera.y * 2., depth, 1.);
  point = p;
  mat = material;
  key = instance;
  ink = tint;
}`;

/** The key's material, the light of up to six struck keys spilling over the caps, the shadows of the black keys, and the dye of a pressed key. */
export const KEY_FRAGMENT_SHADER = `
in vec3 point, mat;
flat in vec4 key, ink;
out vec4 pixel;
uniform vec4 lamps[6];
uniform vec3 colors[6];
uniform int count;
uniform vec4 blockers[37];
uniform int blockerCount;
uniform vec3 underLight[25];
uniform float boardWidth;
void main() {
  float black = key.z;
  vec3 c = vec3(mat.x, mat.x, mat.x * 1.035);
  float seat = mix(.91, 1.05, exp(-point.y * .73));
  c *= seat;
  float across = abs(point.x - key.x);
  float groove = smoothstep(mix(.37, .19, black), mix(.49, .30, black), across);
  c *= 1. - (.18 + .10 * black) * groove;
  c += vec3(.06, .059, .067) * black * exp(-16. * abs(point.x - key.x + .233)) * (.43 + .57 * exp(-.65 * point.y));
  c = mix(c, pow(ink.rgb, vec3(1.42)) * (mat.z * .88 + .08), ink.a * .79);
  float seamLight = 0.;
  for (int i = 0; i < 6; i++) {
    if (i >= count) break;
    vec4 l = lamps[i];
    float dx = point.x - l.x;
    float reach = max(0., point.y - black * .50 - .025);
    seamLight += 4.3 * l.y * exp(-1.12 * dx * dx - 6.6 * reach);
    // The initial white pool on a chord reaches across adjacent caps before it recedes.
    seamLight += 8.6 * l.z * exp(-.89 * dx * dx - 2.18 * reach) * mix(1., .78, black);
    float pool = exp(-.39 * dx * dx / (1.27 + .095 * point.y) - .22 * point.y);
    if (abs(dx) > 10.) continue;
    float trans = 1.;
    if (black < .5) {
      for (int j = 0; j < 37; j++) {
        if (j >= blockerCount) break;
        vec4 b = blockers[j];
        if (abs(b.x - point.x) > 4.9 || b.x < min(point.x, l.x) - .34 || b.x > max(point.x, l.x) + .34) continue;
        float t = clamp((b.x - l.x) / (abs(dx) < .001 ? .001 : dx), .02, .98);
        float along = mix(-.12, point.y, t);
        float crossDist = abs(mix(l.x, point.x, t) - b.x);
        float rayZ = mix(1.02, point.z + .04, t);
        float shadow = (1. - smoothstep(.19, .39, crossDist)) * smoothstep(-.14, .18, along) * (1. - smoothstep(b.y - .07, b.y + .36, along)) * smoothstep(-.12, .15, b.z - rayZ);
        trans = min(trans, 1. - shadow * .76);
      }
    }
    // Diffuse bounce reaches the front lip; the narrow direct lobe still carries cast shadows.
    float bounce = exp(-.048 * dx * dx - .043 * max(0., point.y));
    vec3 spill = (vec3(pool * 1.02 * trans) + vec3(.19, .20, .55) * bounce * (.53 + .23 * smoothstep(1., 4.7, point.y)) * (.67 + .33 * trans))
        * l.y * mix(1.19, .20, black) * mat.y;
    vec3 lampColor = mix(pow(colors[i], vec3(1.46)), vec3(.75, .82, 1.), .15);
    c += lampColor * spill * (vec3(1.) - .75 * c);
    float foot = exp(-.33 * dx * dx) * (.67 * exp(-max(0., point.y) * 1.15) + .17 * exp(-max(0., point.y) * .29));
    float adjacent = min(.76, l.y * foot) * mix(.49 + .51 * trans, .58, black);
    c += max(vec3(0.), vec3(.965, .946, 1.) - c) * adjacent;
  }
  // Light crosses the seam on the key material itself. The rear is almost white;
  // the saturated front and its darker vertical face remain distinct throughout travel.
  float low = min(ink.r, min(ink.g, ink.b)), high = max(ink.r, max(ink.g, ink.b));
  vec3 dye = .295 + .665 * clamp((ink.rgb - low) / max(.001, high - low), 0., 1.);
  float purple = smoothstep(.12, .43, ink.b - ink.g) * smoothstep(.04, .28, ink.r - ink.g);
  dye.r -= .105 * purple;
  float axial = max(0., point.y - .065);
  float heat = .62 * exp(-axial / .49) + .38 * exp(-axial / 1.65);
  vec3 coat = mix(dye, vec3(.998, .986, 1.), heat) * (mat.y < .70 ? .67 : (mat.y < .95 ? .91 : 1.));
  c = mix(c, coat, clamp(key.y * 1.06, 0., 1.));
  c = mix(c, vec3(1., .985, 1.), 1. - exp(-seamLight));
  float underside = smoothstep(4.72, 4.96, point.y) * (1. - smoothstep(.68, .91, mat.y));
  float lane = clamp(point.x / boardWidth * 24., 0., 24.);
  int col = int(lane);
  vec3 baseLamp = mix(underLight[col], underLight[min(24, col + 1)], fract(lane));
  c += baseLamp * underside * .115;
  pixel = vec4(c, 1.);
}`;
