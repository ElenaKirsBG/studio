/* Студия медитаций — звуковой движок (работает в Web Worker).
   Генерация музыки, обработка голоса, сведение, кодирование MP3. */
var SR = 44100;
var TN = 16384, TAB = new Float32Array(TN + 1);
for (var i = 0; i <= TN; i++) TAB[i] = Math.sin(2 * Math.PI * i / TN);
function frac(x) { return x - Math.floor(x); }
function db2g(d) { return Math.pow(10, d / 20); }
function mkRng(seed) { var s = (seed >>> 0) || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

var VOICE = {};           // id -> Float32Array (моно, 44100, нормализовано)
var CUSTOM = null;        // {L, R}

/* ---------- лады / настроения ---------- */
var MOODS = {
  calm:  { dur: 24, chords: [[0,7,12,15,19],[-4,3,7,12,15],[3,10,14,19],[-5,2,5,10,14]], bowls: [12,15,17,19,22,24] },
  light: { dur: 24, chords: [[3,10,14,17,19],[-4,3,7,10,12],[0,7,10,12,15],[-2,5,12,14]], bowls: [15,17,19,22,24,27] },
  deep:  { dur: 30, chords: [[-7,0,5,12],[-7,-2,5,10],[-9,-2,3,10]], bowls: [5,10,12,15,17] },
  space: { dur: 28, chords: [[0,7,14,16,18],[-3,4,11,14,16],[2,9,16,18,23]], bowls: [12,14,16,18,19,23] },
  heart: { dur: 26, chords: [[-7,0,5,9,12],[-2,5,9,14],[0,4,7,12,16],[-4,3,8,12]], bowls: [12,16,19,21,24] }
};

/* ---------- построение таймлайна голоса ---------- */
function buildTimeline(st, order) {
  var t = Math.round(st.intro * SR), segs = [];
  for (var k = 0; k < order.length; k++) {
    var d = VOICE[order[k].id]; if (!d) continue;
    segs.push({ start: t, data: d, gain: db2g(+order[k].gain || 0) });
    t += d.length + Math.round((order[k].pause || 0) * SR);
  }
  var voiceEnd = t;
  var total = Math.max(voiceEnd + Math.round(st.outro * SR), Math.round(st.minTotal * 60 * SR));
  return { segs: segs, total: total, voiceEnd: voiceEnd };
}

/* огибающие голоса по кадрам 10 мс: для гейта и приглушения музыки */
function voiceEnvelopes(tl, st) {
  var FR = 441, n = Math.ceil(tl.total / FR) + 2;
  var rms = new Float32Array(n);
  for (var s = 0; s < tl.segs.length; s++) {
    var sg = tl.segs[s], d = sg.data;
    for (var j = 0; j < d.length; j += FR) {
      var sum = 0, e = Math.min(d.length, j + FR);
      for (var q = j; q < e; q++) sum += d[q] * d[q];
      var fi = Math.floor((sg.start + j) / FR);
      if (fi < n) rms[fi] = Math.max(rms[fi], Math.sqrt(sum / (e - j)) * sg.gain);
    }
  }
  var gate = new Float32Array(n), duck = new Float32Array(n);
  var gThr = db2g(-52), act = new Float32Array(n);
  var hold = 0, g = 0;
  for (var f = 0; f < n; f++) {
    var on = rms[f] > gThr;
    if (on) hold = 25; else if (hold > 0) hold--;
    var target = (on || hold > 0) ? 1 : 0;
    g += (target - g) * (target > g ? 0.8 : 0.06);
    gate[f] = g;
    act[f] = rms[f] > db2g(-42) ? 1 : 0;
  }
  var a = 1 - Math.exp(-1 / 25), r = 1 - Math.exp(-1 / 160), v = 0, sm = new Float32Array(n);
  // скользящее «присутствие голоса» c удержанием 0.6 с
  var hd = 0;
  for (f = 0; f < n; f++) {
    if (act[f]) hd = 60; else if (hd > 0) hd--;
    var tg = hd > 0 ? 1 : 0;
    v += (tg - v) * (tg > v ? a : r);
    sm[f] = v;
  }
  for (f = 0; f < n; f++) duck[f] = sm[Math.min(n - 1, f + 25)]; // упреждение 0.25 с
  return { gate: gate, duck: duck, FR: FR };
}

/* ---------- генераторы ---------- */
function Pad(st, t0) {
  var mood = MOODS[st.mood] || MOODS.calm, base = st.tuning / 4; // A2
  var chords = mood.chords.map(function (ch) {
    return ch.map(function (n, k) {
      var f = base * Math.pow(2, n / 12);
      return {
        f1: f * 0.9985, f2: f * 1.0015, f3: f * 2.001,
        p1: frac(f * 0.9985 * t0), p2: frac(f * 1.0015 * t0), p3: frac(f * 2.001 * t0),
        lf: 0.021 + 0.013 * k, lp: k * 1.7, amp: 1 / Math.sqrt(ch.length) * (f < 90 ? 0.8 : 1)
      };
    });
  });
  this.chords = chords; this.dur = mood.dur; this.xf = 9;
  this.lpL = 0; this.lpR = 0;
  this.w = new Float32Array(chords.length);
}
Pad.prototype.control = function (t) {
  var n = this.chords.length, pos = t / this.dur, i = Math.floor(pos) % n, loc = t - Math.floor(pos) * this.dur;
  for (var k = 0; k < n; k++) this.w[k] = 0;
  var x = loc < this.xf ? loc / this.xf : 1;
  var prev = (i - 1 + n) % n;
  if (t < this.xf) x = 1;
  this.w[i] = Math.sin(x * Math.PI / 2);
  if (x < 1) this.w[prev] = Math.cos(x * Math.PI / 2);
  // «дыхание» нот
  for (k = 0; k < n; k++) {
    var ch = this.chords[k];
    for (var j = 0; j < ch.length; j++) ch[j].g = this.w[k] * ch[j].amp * (0.72 + 0.28 * Math.sin(2 * Math.PI * ch[j].lf * t + ch[j].lp));
  }
};
Pad.prototype.tick = function (out) {
  var L = 0, R = 0, chords = this.chords;
  for (var k = 0; k < chords.length; k++) {
    if (this.w[k] <= 0) continue;
    var ch = chords[k];
    for (var j = 0; j < ch.length; j++) {
      var o = ch[j], g = o.g;
      var a = TAB[(o.p1 * TN) | 0], b = TAB[(o.p2 * TN) | 0], c = TAB[(o.p3 * TN) | 0];
      o.p1 += o.f1 / SR; if (o.p1 >= 1) o.p1 -= 1;
      o.p2 += o.f2 / SR; if (o.p2 >= 1) o.p2 -= 1;
      o.p3 += o.f3 / SR; if (o.p3 >= 1) o.p3 -= 1;
      L += g * (a * 0.75 + b * 0.25 + c * 0.12);
      R += g * (a * 0.25 + b * 0.75 + c * 0.12);
    }
  }
  this.lpL += (L - this.lpL) * 0.12; this.lpR += (R - this.lpR) * 0.12;
  out[0] = this.lpL * 0.2; out[1] = this.lpR * 0.2;
};

function Bowls(st, t0, total) {
  var mood = MOODS[st.mood] || MOODS.calm, base = st.tuning / 4, rnd = mkRng(777 + (st.seed || 0));
  var every = st.bowlEvery || 14, list = [], t = 3 + rnd() * 4, T = total / SR;
  var ratios = [1, 2.71, 5.15, 8.4], amps = [1, 0.42, 0.2, 0.09], dec = [9, 5.5, 2.6, 1.3];
  while (t < T) {
    var n = mood.bowls[Math.floor(rnd() * mood.bowls.length)];
    var f = base * Math.pow(2, n / 12), pan = 0.2 + rnd() * 0.6, vel = 0.65 + rnd() * 0.35;
    var parts = [];
    for (var k = 0; k < 4; k++) parts.push({ f: f * ratios[k], a: amps[k] * vel, d: dec[k] });
    parts.push({ f: f * 1 + 0.55, a: 0.5 * vel, d: 7.5 }); // биения
    list.push({ t: t, parts: parts, pan: pan });
    t += every * (0.6 + 0.8 * rnd());
  }
  this.list = list; this.idx = 0; this.active = [];
  this.reset(t0);
}
Bowls.prototype.reset = function (t0) {
  this.active = [];
  for (var i = 0; i < this.list.length; i++) {
    var s = this.list[i];
    if (s.t <= t0 && t0 - s.t < 14) this.start(s, t0);
    if (s.t > t0) { this.idx = i; return; }
  }
  this.idx = this.list.length;
};
Bowls.prototype.start = function (s, t) {
  var el = t - s.t;
  s.parts.forEach(function (p) { p.ph = frac(p.f * el); });
  this.active.push(s);
};
Bowls.prototype.control = function (t) {
  while (this.idx < this.list.length && this.list[this.idx].t <= t) { this.start(this.list[this.idx], t); this.idx++; }
  var act = [];
  for (var i = 0; i < this.active.length; i++) {
    var s = this.active[i], el = t - s.t;
    if (el > 14) continue;
    var att = Math.min(1, el / 0.04);
    for (var k = 0; k < s.parts.length; k++) s.parts[k].g = s.parts[k].a * att * Math.exp(-el / s.parts[k].d);
    act.push(s);
  }
  this.active = act;
};
Bowls.prototype.tick = function (out) {
  var L = 0, R = 0;
  for (var i = 0; i < this.active.length; i++) {
    var s = this.active[i], v = 0;
    for (var k = 0; k < s.parts.length; k++) {
      var p = s.parts[k];
      v += p.g * TAB[(p.ph * TN) | 0];
      p.ph += p.f / SR; if (p.ph >= 1) p.ph -= 1;
    }
    L += v * (1 - s.pan); R += v * s.pan;
  }
  out[0] = L * 0.24; out[1] = R * 0.24;
};

function Ocean(seed) { this.r = mkRng(seed); this.l1 = 0; this.r1 = 0; this.l2 = 0; this.r2 = 0; this.cL = 0.05; this.cR = 0.05; this.gL = 0; this.gR = 0; }
Ocean.prototype.control = function (t) {
  function wave(t, ph) {
    var x = 0.5 + 0.5 * Math.sin(2 * Math.PI * t / 10.3 + ph + 0.8 * Math.sin(2 * Math.PI * t / 31 + ph));
    return Math.pow(x, 2.2);
  }
  var wl = wave(t, 0), wr = wave(t, 0.9);
  this.gL = 0.18 + 0.82 * wl; this.gR = 0.18 + 0.82 * wr;
  this.cL = 0.012 + 0.09 * wl; this.cR = 0.012 + 0.09 * wr;
};
Ocean.prototype.tick = function (out) {
  var a = this.r() * 2 - 1, b = this.r() * 2 - 1;
  this.l1 += (a - this.l1) * this.cL; this.l2 += (this.l1 - this.l2) * this.cL;
  this.r1 += (b - this.r1) * this.cR; this.r2 += (this.r1 - this.r2) * this.cR;
  out[0] = this.l2 * this.gL * 1.5; out[1] = this.r2 * this.gR * 1.5;
};

function Rain(seed) { this.r = mkRng(seed); this.hl = 0; this.hr = 0; this.ll = 0; this.lr = 0; this.g = 1; this.drop = 0; this.dL = 0.5; }
Rain.prototype.control = function (t) { this.g = 0.8 + 0.2 * Math.sin(2 * Math.PI * t / 17); if (this.r() < 0.06) { this.drop = 0.5 + this.r(); this.dL = this.r(); } };
Rain.prototype.tick = function (out) {
  var a = this.r() * 2 - 1, b = this.r() * 2 - 1;
  this.hl += (a - this.hl) * 0.25; this.hr += (b - this.hr) * 0.25;
  var xl = a - this.hl, xr = b - this.hr;
  this.ll += (xl - this.ll) * 0.45; this.lr += (xr - this.lr) * 0.45;
  var d = 0; if (this.drop > 0.01) { d = (this.r() * 2 - 1) * this.drop; this.drop *= 0.985; }
  out[0] = (this.ll * 0.3 + d * 0.15 * (1 - this.dL)) * this.g;
  out[1] = (this.lr * 0.3 + d * 0.15 * this.dL) * this.g;
};

function Binaural(st, t0) {
  var beats = { alpha: 10, theta: 6, delta: 2.5 };
  this.fl = st.binCarrier || 200; this.fr = this.fl + (beats[st.binType] || 6);
  this.pl = frac(this.fl * t0); this.pr = frac(this.fr * t0);
}
Binaural.prototype.tick = function (out) {
  out[0] = TAB[(this.pl * TN) | 0] * 0.07; out[1] = TAB[(this.pr * TN) | 0] * 0.07;
  this.pl += this.fl / SR; if (this.pl >= 1) this.pl -= 1;
  this.pr += this.fr / SR; if (this.pr >= 1) this.pr -= 1;
};

/* ---------- обработка голоса ---------- */
function Biquad(type, f, q) {
  var w = 2 * Math.PI * f / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), a0;
  if (type === 'hp') { this.b0 = (1 + c) / 2; this.b1 = -(1 + c); this.b2 = (1 + c) / 2; }
  else { this.b0 = (1 - c) / 2; this.b1 = 1 - c; this.b2 = (1 - c) / 2; }
  a0 = 1 + al; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  this.b0 /= a0; this.b1 /= a0; this.b2 /= a0; this.x1 = this.x2 = this.y1 = this.y2 = 0;
}
Biquad.prototype.p = function (x) {
  var y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
  this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
};
function Comb(n, fb, damp) { this.b = new Float32Array(n); this.i = 0; this.fb = fb; this.d = damp; this.s = 0; }
Comb.prototype.p = function (x) { var o = this.b[this.i]; this.s = o * (1 - this.d) + this.s * this.d; this.b[this.i] = x + this.s * this.fb; if (++this.i >= this.b.length) this.i = 0; return o; };
function Allp(n) { this.b = new Float32Array(n); this.i = 0; }
Allp.prototype.p = function (x) { var o = this.b[this.i]; var y = -x + o; this.b[this.i] = x + o * 0.5; if (++this.i >= this.b.length) this.i = 0; return y; };
function Reverb(size) {
  var fb = 0.78 + 0.16 * size, d = 0.25;
  this.cl = [1116, 1188, 1277, 1356, 1422, 1557].map(function (n) { return new Comb(n, fb, d); });
  this.cr = [1139, 1211, 1300, 1379, 1445, 1580].map(function (n) { return new Comb(n, fb, d); });
  this.al = [new Allp(556), new Allp(441)]; this.ar = [new Allp(579), new Allp(464)];
  this.pre = new Float32Array(1764); this.pi = 0; // предзадержка 40 мс
}
Reverb.prototype.p = function (x, out) {
  var xi = this.pre[this.pi]; this.pre[this.pi] = x; if (++this.pi >= this.pre.length) this.pi = 0;
  xi *= 0.02; var L = 0, R = 0, k;
  for (k = 0; k < 6; k++) { L += this.cl[k].p(xi); R += this.cr[k].p(xi); }
  for (k = 0; k < 2; k++) { L = this.al[k].p(L); R = this.ar[k].p(R); }
  out[0] = L; out[1] = R;
};

/* ---------- основной рендер ---------- */
function* renderGen(msg) {
  var st = msg.settings, tl = buildTimeline(st, msg.order);
  var total = tl.total;
  var from = Math.round((msg.from || 0) * SR);
  var to = msg.len ? Math.min(total, from + Math.round(msg.len * SR)) : total;
  if (from >= total) from = Math.max(0, total - SR * 5);
  var warm = Math.min(from, SR * 2), startS = from - warm, t0 = startS / SR;
  var env = voiceEnvelopes(tl, st);

  var pad = st.padVol > 0 ? new Pad(st, t0) : null;
  var bowls = st.bowlVol > 0 ? new Bowls(st, t0, total) : null;
  var ocean = st.oceanVol > 0 ? new Ocean(11) : null;
  var rain = st.rainVol > 0 ? new Rain(23) : null;
  var bin = st.binVol > 0 ? new Binaural(st, t0) : null;
  var cust = (CUSTOM && st.customVol > 0) ? CUSTOM : null;
  var hp = new Biquad('hp', 85, 0.707), lpv = new Biquad('lp', 14000, 0.707);
  var rev = st.reverb > 0 ? new Reverb(st.reverbSize == null ? 0.6 : st.reverbSize) : null;

  var pv = st.padVol / 100, bv = st.bowlVol / 100, ov = st.oceanVol / 100, rv = st.rainVol / 100, nv = st.binVol / 100, cv = st.customVol / 100;
  var music = db2g(st.musicDb), voiceG = db2g(st.voiceDb), duckDepth = 1 - db2g(-st.duckDb);
  var wet = st.reverb / 100 * 1.1, dry = 1 - st.reverb / 100 * 0.25;
  var gateFloor = st.gate ? db2g(-14) : 1;
  var fi = st.fadeIn * SR, fo = st.fadeOut * SR;
  var thr = db2g(-20), ratio = 3, cenv = 0, ca = 1 - Math.exp(-1 / (0.005 * SR)), cr = 1 - Math.exp(-1 / (0.18 * SR)), makeup = db2g(7);
  var gsm = 0, dsm = 0;
  var tmp = [0, 0], rv2 = [0, 0];
  var CH = SR, segI = 0, segs = tl.segs;
  var cN = cust ? cust.L.length : 0, cX = Math.min(3 * SR, Math.floor(cN / 3)), cP = cN - cX;

  for (var cs = startS; cs < to; cs += CH) {
    var ce = Math.min(to, cs + CH), n = ce - cs;
    var outL = new Float32Array(n), outR = new Float32Array(n);
    for (var s = cs; s < ce; s++) {
      if (((s - startS) & 63) === 0) {
        var t = s / SR;
        if (pad) pad.control(t); if (bowls) bowls.control(t); if (ocean) ocean.control(t); if (rain) rain.control(t);
      }
      var mL = 0, mR = 0;
      if (pad) { pad.tick(tmp); mL += tmp[0] * pv; mR += tmp[1] * pv; }
      if (bowls) { bowls.tick(tmp); mL += tmp[0] * bv; mR += tmp[1] * bv; }
      if (ocean) { ocean.tick(tmp); mL += tmp[0] * ov; mR += tmp[1] * ov; }
      if (rain) { rain.tick(tmp); mL += tmp[0] * rv; mR += tmp[1] * rv; }
      if (bin) { bin.tick(tmp); mL += tmp[0] * nv; mR += tmp[1] * nv; }
      if (cust && cN > 0) {
        var loc, kk;
        if (cP > 0) { kk = Math.floor(s / cP); loc = s - kk * cP; } else { kk = 0; loc = s % cN; }
        var a = cust.L[loc], b = cust.R[loc];
        if (kk > 0 && loc < cX) { var x = loc / cX, y = 1 - x; a = a * x + cust.L[loc + cP] * y; b = b * x + cust.R[loc + cP] * y; }
        mL += a * cv * 0.5; mR += b * cv * 0.5;
      }
      // голос
      while (segI < segs.length && segs[segI].start + segs[segI].data.length <= s) segI++;
      var v = 0;
      if (segI < segs.length && s >= segs[segI].start) v = segs[segI].data[s - segs[segI].start] * segs[segI].gain;
      var fr = Math.floor(s / env.FR);
      var gt = env.gate[Math.min(fr, env.gate.length - 1)];
      gsm += (gt - gsm) * 0.004;
      v = lpv.p(hp.p(v)) * (gateFloor + (1 - gateFloor) * gsm);
      if (st.comp) {
        var av = Math.abs(v); cenv += (av - cenv) * (av > cenv ? ca : cr);
        var gr = cenv > thr ? Math.pow(cenv / thr, 1 / ratio - 1) : 1;
        v *= gr * makeup;
      }
      v *= voiceG;
      var vL = v * dry, vR = v * dry;
      if (rev) { rev.p(v, rv2); vL += rv2[0] * wet; vR += rv2[1] * wet; }
      // приглушение музыки под голос
      var dk = env.duck[Math.min(fr, env.duck.length - 1)];
      dsm += (dk - dsm) * 0.0005;
      var mg = music * (1 - duckDepth * dsm);
      if (s < fi) mg *= Math.sin((s / fi) * Math.PI / 2);
      var oL = mL * mg + vL, oR = mR * mg + vR;
      var rem = total - s;
      if (rem < fo) { var fg = Math.sin((rem / fo) * Math.PI / 2); oL *= fg; oR *= fg; }
      // мягкий лимитер
      oL = soft(oL); oR = soft(oR);
      outL[s - cs] = oL; outR[s - cs] = oR;
    }
    if (cs + n > from) {
      var skip = Math.max(0, from - cs);
      yield { L: skip ? outL.subarray(skip) : outL, R: skip ? outR.subarray(skip) : outR, p: (ce - from) / Math.max(1, to - from), total: total / SR };
    }
  }
  return { total: total / SR, voiceEnd: tl.voiceEnd / SR };
}
function render(msg, onChunk, onProgress) {
  var g = renderGen(msg), r;
  while (!(r = g.next()).done) { onChunk(r.value.L, r.value.R); onProgress(r.value.p); }
  return r.value;
}
/* потоковое прослушивание: звук собирается кусками прямо во время воспроизведения */
var STREAM = null;
function streamPart(sec) {
  if (!STREAM) return;
  var need = Math.round(sec * SR), Ls = [], Rs = [], got = 0, done = false, r;
  while (got < need) {
    r = STREAM.gen.next();
    if (r.done) { done = true; break; }
    Ls.push(r.value.L.slice()); Rs.push(r.value.R.slice()); got += r.value.L.length; STREAM.total = r.value.total;
  }
  var L = new Float32Array(got), R2 = new Float32Array(got), o = 0;
  for (var i = 0; i < Ls.length; i++) { L.set(Ls[i], o); R2.set(Rs[i], o); o += Ls[i].length; }
  var start = STREAM.pos; STREAM.pos += got / SR;
  self.postMessage({ cmd: 'streamData', sid: STREAM.sid, L: L, R: R2, start: start, done: done, total: STREAM.total }, [L.buffer, R2.buffer]);
  if (done) STREAM = null;
}
function soft(x) {
  var a = x < 0 ? -x : x;
  if (a <= 0.85) return x;
  var y = 0.85 + 0.14 * Math.tanh((a - 0.85) / 0.14);
  return x < 0 ? -y : y;
}

function toI16(f) { var o = new Int16Array(f.length); for (var i = 0; i < f.length; i++) { var v = f[i]; o[i] = v < 0 ? Math.max(-32768, v * 32768) : Math.min(32767, v * 32767); } return o; }

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = function (e) {
    var m = e.data;
    try {
      if (m.cmd === 'voice') { VOICE[m.id] = m.data; return; }
      if (m.cmd === 'dropVoice') { delete VOICE[m.id]; return; }
      if (m.cmd === 'custom') { CUSTOM = m.data; return; }
      if (m.cmd === 'info') { var tl = buildTimeline(m.settings, m.order); self.postMessage({ cmd: 'info', total: tl.total / SR, voiceEnd: tl.voiceEnd / SR, reqId: m.reqId }); return; }
      if (m.cmd === 'streamStart') { STREAM = { gen: renderGen(m), sid: m.sid, pos: m.from || 0, total: 0 }; streamPart(m.first || 6); return; }
      if (m.cmd === 'streamMore') { if (STREAM && STREAM.sid === m.sid) streamPart(m.sec || 15); return; }
      if (m.cmd === 'streamStop') { STREAM = null; return; }
      if (m.cmd === 'render') {
        var lastP = 0;
        var prog = function (p) { var now = Date.now(); if (now - lastP > 250) { lastP = now; self.postMessage({ cmd: 'progress', p: p, job: m.job }); } };
        if (m.mode === 'preview') {
          var Ls = [], Rs = [], len = 0;
          var info = render(m, function (l, r) { Ls.push(l.slice()); Rs.push(r.slice()); len += l.length; }, prog);
          var L = new Float32Array(len), R = new Float32Array(len), o = 0;
          for (var i = 0; i < Ls.length; i++) { L.set(Ls[i], o); R.set(Rs[i], o); o += Ls[i].length; }
          self.postMessage({ cmd: 'preview', L: L, R: R, job: m.job, info: info }, [L.buffer, R.buffer]);
        } else {
          var mono = !!m.mono, enc = new lamejs.Mp3Encoder(mono ? 1 : 2, SR, m.kbps || 160), parts = [];
          var info2 = render(m, function (l, r) {
            var li, ri, k, b;
            if (mono) { var mx = new Float32Array(l.length); for (k = 0; k < l.length; k++) mx[k] = (l[k] + r[k]) * 0.5; li = toI16(mx); }
            else { li = toI16(l); ri = toI16(r); }
            for (k = 0; k < li.length; k += 11520) {
              b = mono ? enc.encodeBuffer(li.subarray(k, k + 11520)) : enc.encodeBuffer(li.subarray(k, k + 11520), ri.subarray(k, k + 11520));
              if (b.length) parts.push(b);
            }
          }, prog);
          var fl = enc.flush(); if (fl.length) parts.push(fl);
          var blob = new Blob(parts, { type: 'audio/mpeg' });
          self.postMessage({ cmd: 'mp3', blob: blob, job: m.job, info: info2 });
        }
      }
    } catch (err) { self.postMessage({ cmd: 'error', message: String(err && err.message || err), job: m.job }); }
  };
}
if (typeof module !== 'undefined') module.exports = { render: render, VOICE: VOICE, setCustom: function (c) { CUSTOM = c; }, SR: SR, buildTimeline: buildTimeline };
