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

/* ---------- лады / настроения ----------
   Числа — полутоны от ноты A (ля) нижней октавы. root — тоника для бурдона.
   Все аккорды каждого настроения взяты из одного лада, поэтому мелодия, чаши и колокольчики,
   которые берут ноты из текущего аккорда, никогда не фальшивят. */
var MOODS = {
  calm:    { dur: 24, root: 0, chords: [[0,7,12,15,19],[-4,3,7,12,15],[3,10,14,19],[-5,2,5,10,14]], bowls: [12,15,17,19,22,24] },
  light:   { dur: 24, root: 3, chords: [[3,10,14,17,19],[-4,3,7,10,12],[0,7,10,12,15],[-2,5,12,14]], bowls: [15,17,19,22,24,27] },
  deep:    { dur: 30, root: 5, chords: [[-7,0,5,12],[-7,-2,5,10],[-9,-2,3,10]], bowls: [5,10,12,15,17] },
  space:   { dur: 28, root: 0, chords: [[0,7,14,16,18],[-3,4,11,14,16],[2,9,16,18,23]], bowls: [12,14,16,18,19,23] },
  heart:   { dur: 26, root: 5, chords: [[-7,0,5,9,12],[-2,5,9,14],[0,4,7,12,16],[-4,3,8,12]], bowls: [12,16,19,21,24] },
  forest:  { dur: 26, root: 0, chords: [[0,7,12,16,18],[2,9,14,18,21],[-5,2,7,11,14],[-3,4,9,12,16]], bowls: [12,14,16,18,19,21] },
  sea:     { dur: 30, root: 0, chords: [[0,7,12,14,19],[-5,2,7,9,14],[-3,4,9,11,16],[-7,0,5,7,12]], bowls: [12,14,16,19,21,24] },
  dream:   { dur: 28, root: 0, chords: [[0,4,11,14,16],[-7,-3,4,7,9],[-8,-5,-1,2,7],[-10,-7,-3,0,4]], bowls: [11,14,16,19,23] },
  night:   { dur: 36, root: 0, chords: [[-12,-5,0,3,7],[-16,-9,-4,0,3],[-14,-7,-2,2,5]], bowls: [7,10,12,15] },
  ancient: { dur: 32, root: 0, chords: [[-12,-5,0,3,7],[-12,-5,2,5,9],[-12,-5,-2,5,10],[-12,-5,0,5,9]], bowls: [0,5,7,12,15,17] },
  sunrise: { dur: 22, root: 0, chords: [[0,4,7,12,16],[-5,-1,2,7,11],[-3,0,4,9,12],[-7,-3,0,5,9]], bowls: [12,16,19,21,24] },
  crystal: { dur: 26, root: 0, chords: [[12,19,24,26,31],[7,14,19,23,26],[9,16,21,24,28],[5,12,17,21,24]], bowls: [24,26,28,31,33,36] }
};
function moodOf(st) { return MOODS[st.mood] || MOODS.calm; }
function chordDur(st) { return moodOf(st).dur * ((st.chordSlow || 100) / 100); }
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
  var rms = new Float32Array(n), gth = new Float32Array(n).fill(db2g(-52));
  for (var s = 0; s < tl.segs.length; s++) {
    var sg = tl.segs[s], d = sg.data, loc = [];
    for (var j = 0; j < d.length; j += FR) {
      var sum = 0, e = Math.min(d.length, j + FR);
      for (var q = j; q < e; q++) sum += d[q] * d[q];
      var fv = Math.sqrt(sum / (e - j)) * sg.gain; loc.push(fv);
      var fi = Math.floor((sg.start + j) / FR);
      if (fi < n) rms[fi] = Math.max(rms[fi], fv);
    }
    // Порог «тишины между фразами» — по фону именно этого фрагмента: у каждой записи свой шум комнаты,
    // и после выравнивания громкости он разный. Так фон убирается одинаково во всех фрагментах.
    var srt = loc.slice().sort(function (x, y) { return x - y; });
    var noise = srt[Math.floor(srt.length * 0.1)] || 0, speech = srt[Math.floor(srt.length * 0.9)] || 0;
    var t = Math.min(Math.max(noise * 3.2, db2g(-58)), Math.max(speech * 0.12, db2g(-58)));
    var f0 = Math.floor(sg.start / FR), f1 = Math.min(n, Math.ceil((sg.start + d.length) / FR));
    for (var ff = f0; ff < f1; ff++) gth[ff] = t;
  }
  var gate = new Float32Array(n), duck = new Float32Array(n);
  var act = new Float32Array(n);
  var hold = 0, g = 0;
  for (var f = 0; f < n; f++) {
    var on = rms[f] > gth[f];
    if (on) hold = 30; else if (hold > 0) hold--;
    var target = (on || hold > 0) ? 1 : 0;
    g += (target - g) * (target > g ? 0.7 : 0.03);
    gate[f] = g;
    act[f] = rms[f] > db2g(-42) ? 1 : 0;
  }
  var a = 1 - Math.exp(-1 / 25), r = 1 - Math.exp(-1 / 100), v = 0, sm = new Float32Array(n);
  // скользящее «присутствие голоса» c удержанием 0,45 с: в паузах между фразами музыка успевает «вздохнуть»
  var hd = 0;
  for (f = 0; f < n; f++) {
    if (act[f]) hd = 45; else if (hd > 0) hd--;
    var tg = hd > 0 ? 1 : 0;
    v += (tg - v) * (tg > v ? a : r);
    sm[f] = v;
  }
  for (f = 0; f < n; f++) duck[f] = sm[Math.min(n - 1, f + 25)]; // упреждение 0.25 с
  return { gate: gate, duck: duck, FR: FR };
}

/* ---------- генераторы ---------- */
/* Тембры пэда: det — расстройка (ширина), c — октава, d — верхний обертон, lp — яркость, br — «дыхание» */
var PADTONES = {
  warm:  { det: 0.0015, c: 0.12, d: 0,    lp: 0.12, g: 1,    br: 0.28 },
  soft:  { det: 0.001,  c: 0,    d: 0,    lp: 0.05, g: 1.05, br: 0.2 },
  choir: { det: 0.0045, c: 0.22, d: 0.1,  lp: 0.22, g: 0.95, br: 0.36 },
  organ: { det: 0.0007, c: 0.42, d: 0.24, lp: 0.3,  g: 0.7,  br: 0.06 },
  glass: { det: 0.002,  c: 0.3,  d: 0.17, lp: 0.42, g: 0.9, br: 0.45, dr: 4.007 }
};
function Pad(st, t0) {
  var mood = moodOf(st), base = st.tuning / 4, T = PADTONES[st.padTone] || PADTONES.warm, det = T.det, dr = T.dr || 3.003;
  var chords = mood.chords.map(function (ch) {
    return ch.map(function (n, k) {
      var f = base * Math.pow(2, n / 12);
      return {
        f1: f * (1 - det), f2: f * (1 + det), f3: f * 2.001, f4: f * dr,
        p1: frac(f * (1 - det) * t0), p2: frac(f * (1 + det) * t0), p3: frac(f * 2.001 * t0), p4: frac(f * dr * t0),
        lf: 0.021 + 0.013 * k, lp: k * 1.7, amp: 1 / Math.sqrt(ch.length) * (f < 90 ? 0.8 : 1) * (f > 500 ? 0.75 : 1)
      };
    });
  });
  this.T = T; this.chords = chords; this.dur = chordDur(st); this.xf = Math.min(9 * this.dur / mood.dur, this.dur * 0.45);
  this.lpL = 0; this.lpR = 0;
  this.w = new Float32Array(chords.length);
}
Pad.prototype.control = function (t) {
  var n = this.chords.length, pos = t / this.dur, i = Math.floor(pos) % n, loc = t - Math.floor(pos) * this.dur, br = this.T.br;
  for (var k = 0; k < n; k++) this.w[k] = 0;
  var x = loc < this.xf ? loc / this.xf : 1;
  var prev = (i - 1 + n) % n;
  if (t < this.xf) x = 1;
  this.w[i] = Math.sin(x * Math.PI / 2);
  if (x < 1) this.w[prev] = Math.cos(x * Math.PI / 2);
  for (k = 0; k < n; k++) {
    var ch = this.chords[k];
    for (var j = 0; j < ch.length; j++) ch[j].g = this.w[k] * ch[j].amp * ((1 - br) + br * Math.sin(2 * Math.PI * ch[j].lf * t + ch[j].lp));
  }
};
Pad.prototype.tick = function (out) {
  var L = 0, R = 0, chords = this.chords, cw = this.T.c, dw = this.T.d;
  for (var k = 0; k < chords.length; k++) {
    if (this.w[k] <= 0) continue;
    var ch = chords[k];
    for (var j = 0; j < ch.length; j++) {
      var o = ch[j], g = o.g;
      var a = TAB[(o.p1 * TN) | 0], b = TAB[(o.p2 * TN) | 0], c = TAB[(o.p3 * TN) | 0];
      o.p1 += o.f1 / SR; if (o.p1 >= 1) o.p1 -= 1;
      o.p2 += o.f2 / SR; if (o.p2 >= 1) o.p2 -= 1;
      o.p3 += o.f3 / SR; if (o.p3 >= 1) o.p3 -= 1;
      var cl = a * 0.75 + b * 0.25 + c * cw, cr = a * 0.25 + b * 0.75 + c * cw;
      if (dw) { var d = TAB[(o.p4 * TN) | 0]; o.p4 += o.f4 / SR; if (o.p4 >= 1) o.p4 -= 1; cl += d * dw; cr += d * dw * 0.9; }
      L += g * cl; R += g * cr;
    }
  }
  var lp = this.T.lp;
  this.lpL += (L - this.lpL) * lp; this.lpR += (R - this.lpR) * lp;
  out[0] = this.lpL * 0.2 * this.T.g; out[1] = this.lpR * 0.2 * this.T.g;
};

/* Низкий бурдон «Ом»: тоника на октаву ниже, гармоники с формантами гласной «о» */
function Drone(st, t0) {
  var r = ((moodOf(st).root || 0) % 12 + 12) % 12; if (r > 6) r -= 12;
  var f = st.tuning / 8 * Math.pow(2, r / 12), hs = [], sum = 0;
  for (var k = 1; k <= 10; k++) {
    var fk = f * k, w = 0.5 / k + Math.exp(-Math.pow((fk - 470) / 170, 2)) + 0.55 * Math.exp(-Math.pow((fk - 820) / 250, 2));
    hs.push({ fl: fk, fr: fk * 1.0025, pl: frac(fk * t0), pr: frac(fk * 1.0025 * t0), w: w }); sum += w;
  }
  hs.forEach(function (h) { h.w /= sum; });
  this.hs = hs; this.g = 1; this.lp = 0; this.rp = 0;
}
Drone.prototype.control = function (t) { this.g = 0.72 + 0.28 * Math.sin(2 * Math.PI * t / 23 + 0.5 * Math.sin(2 * Math.PI * t / 61)); };
Drone.prototype.tick = function (out) {
  var L = 0, R = 0, hs = this.hs;
  for (var k = 0; k < hs.length; k++) {
    var h = hs[k];
    L += h.w * TAB[(h.pl * TN) | 0]; R += h.w * TAB[(h.pr * TN) | 0];
    h.pl += h.fl / SR; if (h.pl >= 1) h.pl -= 1;
    h.pr += h.fr / SR; if (h.pr >= 1) h.pr -= 1;
  }
  this.lp += (L - this.lp) * 0.2; this.rp += (R - this.rp) * 0.2;
  out[0] = this.lp * 0.42 * this.g; out[1] = this.rp * 0.42 * this.g;
};

function Bowls(st, t0, total) {
  var mood = moodOf(st), base = st.tuning / 4, rnd = mkRng(777 + (st.seed || 0) * 131);
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

/* ---------- мелодия и колокольчики: ноты берутся из текущего аккорда ---------- */
var INST = {
  harp:    { p: [1, 2, 3, 4],        a: [1, 0.45, 0.22, 0.1],        d: [2.6, 1.5, 0.9, 0.5],       att: 0.004, g: 1 },
  kalimba: { p: [1, 5.4, 9.1],       a: [1, 0.22, 0.07],             d: [1.7, 0.22, 0.1],           att: 0.002, g: 1.1 },
  piano:   { p: [1, 2, 3, 4, 6],     a: [1, 0.38, 0.16, 0.08, 0.04], d: [3.2, 1.7, 1, 0.6, 0.35],   att: 0.006, g: 0.95 },
  bells:   { p: [1, 2.76, 5.4, 8.93],a: [1, 0.45, 0.25, 0.12],       d: [4.5, 2.6, 1.4, 0.7],       att: 0.002, g: 0.8 },
  flute:   { p: [1, 2, 3],           a: [1, 0.28, 0.09],             sus: true, att: 0.22, rel: 0.7, g: 1.1 }
};
function noteEvents(st, total, kind) {
  var mood = moodOf(st), base = st.tuning / 4, rnd = mkRng(1234 + (st.seed || 0) * 97 + (kind === 'chimes' ? 555 : 0));
  var dur = chordDur(st), n = mood.chords.length, T = total / SR, list = [];
  function pool(t, lo, hi) {
    var ch = mood.chords[Math.floor(t / dur) % n], out = [];
    ch.forEach(function (x) { for (var o = 0; o <= 36; o += 12) { var f = base * Math.pow(2, (x + o) / 12); if (f >= lo && f <= hi && out.indexOf(f) < 0) out.push(f); } });
    return out.sort(function (a, b) { return a - b; });
  }
  var t, P, j;
  if (kind === 'chimes') {
    t = 5 + rnd() * 6;
    while (t < T) {
      var cnt = 3 + Math.floor(rnd() * 5), tt = t;
      for (j = 0; j < cnt; j++) {
        P = pool(tt, 700, 2600);
        if (P.length) list.push({ t: tt, f: P[Math.floor(rnd() * P.length)], pan: 0.15 + rnd() * 0.7, vel: 0.3 + rnd() * 0.5 });
        tt += 0.1 + rnd() * 0.5;
      }
      t += 12 + rnd() * 22;
    }
    return list;
  }
  var inst = st.melInst || 'harp', sus = inst === 'flute', every = st.melEvery || 10, idx = -1;
  var lo = sus ? 260 : 220, hi = sus ? 880 : 1000;
  t = 4 + rnd() * 4;
  while (t < T) {
    P = pool(t, lo, hi); if (!P.length) { t += every; continue; }
    var len = 2 + Math.floor(rnd() * (sus ? 2 : 4));
    if (idx < 0 || idx >= P.length) idx = Math.floor(rnd() * P.length);
    for (j = 0; j < len && t < T; j++) {
      P = pool(t, lo, hi);
      var r = rnd(), step = r < 0.35 ? -1 : r < 0.7 ? 1 : r < 0.85 ? -2 : 2;
      idx = Math.max(0, Math.min(P.length - 1, idx + (j ? step : 0)));
      var nd = sus ? 1.1 + rnd() * 1.3 : 0.35 + rnd() * 0.75;
      list.push({ t: t, f: P[idx], pan: 0.35 + rnd() * 0.3, vel: 0.55 + rnd() * 0.4, len: sus ? nd * 0.9 : 0 });
      t += nd;
    }
    t += every * (0.6 + 0.8 * rnd());
  }
  return list;
}
function Notes(list, inst, t0, seed) {
  this.list = list; this.I = INST[inst] || INST.harp; this.idx = 0; this.active = []; this.r = mkRng(seed || 99);
  var I = this.I, life = I.sus ? 0 : I.d[0] * 6;
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (s.t > t0) { this.idx = i; break; }
    this.idx = i + 1;
    if (t0 - s.t < (I.sus ? s.len + I.rel : life)) this.start(s, t0);
  }
}
Notes.prototype.start = function (s, t) {
  var I = this.I, el = t - s.t;
  s.parts = I.p.map(function (r, k) { return { f: s.f * r, a: I.a[k] * s.vel, d: I.d ? I.d[k] : 0, ph: frac(s.f * r * el), inc: s.f * r / SR, g: 0 }; });
  s.env = 0; this.active.push(s);
};
Notes.prototype.control = function (t) {
  while (this.idx < this.list.length && this.list[this.idx].t <= t) { this.start(this.list[this.idx], t); this.idx++; }
  var I = this.I, act = [];
  for (var i = 0; i < this.active.length; i++) {
    var s = this.active[i], el = t - s.t, k;
    if (I.sus) {
      if (el > s.len + I.rel) continue;
      var e = el < I.att ? el / I.att : 1;
      if (el > s.len) e *= Math.max(0, 1 - (el - s.len) / I.rel);
      var vib = el > 0.4 ? 1 + 0.0045 * Math.sin(2 * Math.PI * 5.2 * el) * Math.min(1, (el - 0.4) / 0.4) : 1;
      s.env = e;
      for (k = 0; k < s.parts.length; k++) { var p = s.parts[k]; p.g = p.a * e; p.inc = p.f * vib / SR; }
    } else {
      if (el > I.d[0] * 6) continue;
      var at = Math.min(1, el / I.att);
      for (k = 0; k < s.parts.length; k++) s.parts[k].g = s.parts[k].a * at * Math.exp(-el / s.parts[k].d);
    }
    act.push(s);
  }
  this.active = act;
};
Notes.prototype.tick = function (out) {
  var L = 0, R = 0, sus = this.I.sus;
  for (var i = 0; i < this.active.length; i++) {
    var s = this.active[i], v = 0;
    for (var k = 0; k < s.parts.length; k++) {
      var p = s.parts[k];
      v += p.g * TAB[(p.ph * TN) | 0];
      p.ph += p.inc; if (p.ph >= 1) p.ph -= 1;
    }
    if (sus) v += (this.r() * 2 - 1) * 0.018 * s.env * s.vel; // дыхание флейты
    L += v * (1 - s.pan); R += v * s.pan;
  }
  out[0] = L * 0.2 * this.I.g; out[1] = R * 0.2 * this.I.g;
};

/* ---------- природа ---------- */
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

/* полосовой фильтр (Чемберлен) */
function SVF() { this.lo = 0; this.bp = 0; }
SVF.prototype.p = function (x, F, q) { this.lo += F * this.bp; var hi = x - this.lo - q * this.bp; this.bp += F * hi; return this.bp; };

function Wind(seed) { this.r = mkRng(seed); this.fl = new SVF(); this.fr = new SVF(); this.Fl = 0.05; this.Fr = 0.05; this.gl = 0; this.gr = 0; }
Wind.prototype.control = function (t) {
  function c(t, ph) { return 0.5 + 0.5 * Math.sin(2 * Math.PI * t / 13 + ph + 0.8 * Math.sin(2 * Math.PI * t / 37 + ph)); }
  function g(t, ph) { return 0.2 + 0.8 * Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t / 9.7 + ph + Math.sin(2 * Math.PI * t / 29 + ph)), 2); }
  this.Fl = 2 * Math.sin(Math.PI * (220 + 600 * c(t, 0)) / SR); this.Fr = 2 * Math.sin(Math.PI * (220 + 600 * c(t, 1.3)) / SR);
  this.gl = g(t, 0); this.gr = g(t, 0.7);
};
Wind.prototype.tick = function (out) {
  out[0] = this.fl.p(this.r() * 2 - 1, this.Fl, 0.35) * this.gl * 0.55;
  out[1] = this.fr.p(this.r() * 2 - 1, this.Fr, 0.35) * this.gr * 0.55;
};

function Stream(seed) {
  this.r = mkRng(seed); this.f1 = new SVF(); this.f2 = new SVF(); this.f3 = new SVF(); this.f4 = new SVF();
  this.a1 = 0.5; this.a2 = 0.5; this.a3 = 0.5; this.a4 = 0.5; this.bub = [];
}
Stream.prototype.control = function () {
  var r = this.r;
  function walk(a) { a += (r() - 0.5) * 0.35; return a < 0.15 ? 0.15 : a > 1 ? 1 : a; }
  this.a1 = walk(this.a1); this.a2 = walk(this.a2); this.a3 = walk(this.a3); this.a4 = walk(this.a4);
  if (r() < 0.012) this.bub.push({ f: 350 + r() * 650, ph: 0, a: 0.25 + r() * 0.5, pan: r() });
};
Stream.prototype.tick = function (out) {
  var r = this.r, F1 = 0.17, F2 = 0.36;
  var L = this.f1.p(r() * 2 - 1, F1, 0.28) * this.a1 + this.f2.p(r() * 2 - 1, F2, 0.3) * this.a2 * 0.7;
  var R = this.f3.p(r() * 2 - 1, F1 * 1.08, 0.28) * this.a3 + this.f4.p(r() * 2 - 1, F2 * 0.93, 0.3) * this.a4 * 0.7;
  if (this.bub.length) {
    var keep = [];
    for (var i = 0; i < this.bub.length; i++) {
      var b = this.bub[i], v = TAB[(b.ph * TN) | 0] * b.a;
      b.ph += b.f / SR; if (b.ph >= 1) b.ph -= 1; b.f *= 1.00008; b.a *= 0.9985;
      L += v * (1 - b.pan); R += v * b.pan;
      if (b.a > 0.01) keep.push(b);
    }
    this.bub = keep;
  }
  out[0] = L * 0.22; out[1] = R * 0.22;
};

/* птицы: свисты, трели, короткие щебетания, изредка мягкое воркование */
function Birds(st, t0, total) {
  var rnd = mkRng(4242 + (st.seed || 0) * 71), T = total / SR, list = [], t = 1.5 + rnd() * 3;
  while (t < T) {
    var type = rnd(), pan = 0.1 + rnd() * 0.8, vel = 0.35 + rnd() * 0.65, tt = t, k, n;
    if (type < 0.4) {               // свист
      var f = 2200 + rnd() * 1100, up = rnd() < 0.5 ? 1.25 : 0.8; n = 2 + Math.floor(rnd() * 3);
      for (k = 0; k < n; k++) { var l = 0.12 + rnd() * 0.1; list.push({ t: tt, len: l, f0: f, f1: f * up, pan: pan, vel: vel }); tt += l + 0.06 + rnd() * 0.08; }
    } else if (type < 0.7) {        // трель
      var f2 = 3800 + rnd() * 1200; n = 6 + Math.floor(rnd() * 8);
      for (k = 0; k < n; k++) { list.push({ t: tt, len: 0.035, f0: f2, f1: f2 * 0.92, pan: pan, vel: vel * 0.7 }); tt += 0.06; f2 *= 0.99; }
    } else if (type < 0.94) {       // щебет
      n = 1 + Math.floor(rnd() * 3);
      for (k = 0; k < n; k++) { var f3 = 4200 + rnd() * 900; list.push({ t: tt, len: 0.07, f0: f3, f1: f3 * 0.55, pan: pan, vel: vel * 0.8 }); tt += 0.12 + rnd() * 0.1; }
    } else {                        // воркование вдали
      var f4 = 480 + rnd() * 80;
      for (k = 0; k < 3; k++) { list.push({ t: tt, len: k === 1 ? 0.45 : 0.25, f0: f4 * (k === 1 ? 1.06 : 1), f1: f4 * 0.97, pan: pan, vel: vel * 0.9, low: 1 }); tt += 0.55; }
    }
    t = tt + 1.2 + rnd() * 5.5;
  }
  this.list = list; this.idx = 0; this.active = [];
  while (this.idx < list.length && list[this.idx].t < t0) this.idx++;
  this.t = t0;
}
Birds.prototype.control = function (t) { this.t = t; while (this.idx < this.list.length && this.list[this.idx].t <= t) { var s = this.list[this.idx++]; s.ph = 0; s.x = (t - s.t) / s.len; this.active.push(s); } };
Birds.prototype.tick = function (out) {
  var L = 0, R = 0, keep = [];
  for (var i = 0; i < this.active.length; i++) {
    var s = this.active[i];
    if (s.x >= 1) continue;
    var f = s.f0 + (s.f1 - s.f0) * s.x, e = Math.sin(Math.PI * s.x), v = TAB[(s.ph * TN) | 0] * e * e * s.vel;
    if (s.low) v *= 1.6;
    s.ph += f / SR; if (s.ph >= 1) s.ph -= 1; s.x += 1 / (s.len * SR);
    L += v * (1 - s.pan); R += v * s.pan; keep.push(s);
  }
  this.active = keep;
  out[0] = L * 0.32; out[1] = R * 0.32;
};

/* сверчки: короткие серии импульсов на высокой частоте */
function Crickets(t0) {
  this.c = [{ f: 4350, pan: 0.25, P: 0.93, o: 0.1, ph: 0 }, { f: 4720, pan: 0.78, P: 1.07, o: 0.47, ph: 0 }, { f: 4050, pan: 0.5, P: 1.31, o: 0.8, ph: 0, far: 0.45 }];
  this.t = t0; this.sw = 1;
}
Crickets.prototype.control = function (t) { this.t = t; this.sw = 0.75 + 0.25 * Math.sin(2 * Math.PI * t / 41); };
Crickets.prototype.tick = function (out) {
  var L = 0, R = 0, t = this.t;
  for (var i = 0; i < this.c.length; i++) {
    var c = this.c[i], tc = t + c.o, nchirp = Math.floor(tc / c.P), loc = tc - nchirp * c.P, e = 0;
    var h = frac(Math.sin(nchirp * 12.9898 + i * 78.233) * 43758.5453);
    if (h > 0.18) { var pi = Math.floor(loc / 0.034); if (pi < 3) { var x = (loc - pi * 0.034) / 0.02; if (x < 1) { e = Math.sin(Math.PI * x); e *= e; } } }
    var v = TAB[(c.ph * TN) | 0] * e * (c.far || 1);
    c.ph += c.f / SR; if (c.ph >= 1) c.ph -= 1;
    L += v * (1 - c.pan); R += v * c.pan;
  }
  this.t += 1 / SR;
  out[0] = L * 0.3 * this.sw; out[1] = R * 0.3 * this.sw;
};

/* костёр: тёплый гул + потрескивания */
function Fire(seed) { this.r = mkRng(seed); this.l = 0; this.rr = 0; this.cr = []; this.g = 1; this.pl = 0; this.pr = 0; }
Fire.prototype.control = function (t) {
  this.g = 0.75 + 0.25 * Math.sin(2 * Math.PI * t / 7 + Math.sin(2 * Math.PI * t / 3.1));
  var r = this.r;
  if (r() < 0.018) this.cr.push({ a: (r() < 0.12 ? 0.9 : 0.25) + r() * 0.35, d: 0.93 + r() * 0.05, pan: r() });
};
Fire.prototype.tick = function (out) {
  var r = this.r, a = r() * 2 - 1, b = r() * 2 - 1;
  this.l += (a - this.l) * 0.012; this.rr += (b - this.rr) * 0.012;
  var L = this.l * 2.6 * this.g, R = this.rr * 2.6 * this.g;
  if (this.cr.length) {
    var keep = [], n = r() * 2 - 1, hp = n - this.pl; this.pl = n;
    for (var i = 0; i < this.cr.length; i++) {
      var c = this.cr[i], v = hp * c.a;
      L += v * (1 - c.pan); R += v * c.pan; c.a *= c.d;
      if (c.a > 0.004) keep.push(c);
    }
    this.cr = keep;
  }
  out[0] = L * 0.3; out[1] = R * 0.3;
};

/* мягкий «коричневый» шум — ровный, глухой, как шум далёкого водопада */
function Brown(seed) { this.r = mkRng(seed); this.l = 0; this.rr = 0; }
Brown.prototype.tick = function (out) {
  this.l = (this.l + 0.02 * (this.r() * 2 - 1)) / 1.02; this.rr = (this.rr + 0.02 * (this.r() * 2 - 1)) / 1.02;
  out[0] = this.l * 1.15; out[1] = this.rr * 1.15;
};

/* сердцебиение: «тук-тук» в спокойном ритме */
function Heart(st, t0) { this.P = 60 / (st.hbBpm || 60); this.t = t0; this.lp = 0; }
Heart.prototype.control = function (t) { this.t = t; };
Heart.prototype.tick = function (out) {
  var tc = this.t % this.P, v = 0, x;
  if (tc < 0.3) { x = tc; v += Math.sin(2 * Math.PI * 52 * x) * Math.exp(-x / 0.06) * Math.min(1, x / 0.008); v += 0.35 * Math.sin(2 * Math.PI * 104 * x) * Math.exp(-x / 0.04) * Math.min(1, x / 0.008); }
  if (tc > 0.27 && tc < 0.6) { x = tc - 0.27; v += 0.7 * (Math.sin(2 * Math.PI * 64 * x) + 0.35 * Math.sin(2 * Math.PI * 128 * x)) * Math.exp(-x / 0.045) * Math.min(1, x / 0.008); }
  this.lp += (v - this.lp) * 0.3; this.t += 1 / SR;
  out[0] = this.lp * 0.5; out[1] = this.lp * 0.5;
};

/* тон выбранной частоты (528 Гц и др.) — чистый мягкий тон с медленной «волной» */
function Tone(st, t0) { this.f = st.toneHz || 528; this.p = frac(this.f * t0); this.q = frac(this.f * 1.0007 * t0); this.g = 1; }
Tone.prototype.control = function (t) { this.g = 0.7 + 0.3 * Math.sin(2 * Math.PI * t / 11); };
Tone.prototype.tick = function (out) {
  var a = TAB[(this.p * TN) | 0], b = TAB[(this.q * TN) | 0];
  this.p += this.f / SR; if (this.p >= 1) this.p -= 1;
  this.q += this.f * 1.0007 / SR; if (this.q >= 1) this.q -= 1;
  out[0] = a * 0.08 * this.g; out[1] = b * 0.08 * this.g;
};

/* ---------- ритмы мозга: бинауральные, монауральные, изохронные ----------
   Несущая «по строю» = ля малой октавы (216 Гц при 432 / 220 при 440) — совпадает с музыкой.
   Плавный вход: ритм начинается с альфы 10 Гц и за 5 минут опускается к выбранному. */
var BEATS = { delta: 2.5, theta4: 4, theta: 6, schumann: 7.83, alpha8: 8, alpha: 10, smr: 12, beta: 15 };
function Binaural(st, t0) {
  this.fl = +st.binCarrier || st.tuning / 2; this.fb = BEATS[st.binType] || 6; this.mode = st.binMode || 'binaural';
  this.R = (st.binRamp && this.fb < 10) ? 300 : 0; this.D = 10 - this.fb;
  this.pl = frac(this.fl * t0); this.pr = frac(this.fl * t0 + this.beatInt(t0)); this.pb = frac(this.beatInt(t0));
  this.cur = this.beatAt(t0); this.lp = 0;
}
Binaural.prototype.beatAt = function (t) { return this.R && t < this.R ? this.fb + this.D * (1 - t / this.R) : this.fb; };
Binaural.prototype.beatInt = function (t) { var R = this.R; if (!R) return this.fb * t; return t < R ? this.fb * t + this.D * (t - t * t / (2 * R)) : this.fb * t + this.D * R / 2; };
Binaural.prototype.control = function (t) { this.cur = this.beatAt(t); };
Binaural.prototype.tick = function (out) {
  var a = TAB[(this.pl * TN) | 0];
  this.pl += this.fl / SR; if (this.pl >= 1) this.pl -= 1;
  if (this.mode === 'iso') {
    var e = 0.5 - 0.5 * TAB[(((this.pb + 0.25) % 1) * TN) | 0]; e = e * e;
    this.pb += this.cur / SR; if (this.pb >= 1) this.pb -= 1;
    this.lp += (e - this.lp) * 0.02;
    out[0] = out[1] = a * this.lp * 0.09; return;
  }
  var b = TAB[(this.pr * TN) | 0];
  this.pr += (this.fl + this.cur) / SR; if (this.pr >= 1) this.pr -= 1;
  if (this.mode === 'mono') { out[0] = out[1] = (a + b) * 0.045; return; }
  out[0] = a * 0.07; out[1] = b * 0.07;
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

/* ---------- шумоподавление голоса (спектральное) ----------
   Профиль шума берётся из самых тихих кадров записи (паузы между словами, начало и конец).
   Затем в каждом кадре 23 мс подавляются только те частоты, где энергии не больше, чем у шума:
   шипение уходит и во время речи, а сам голос не меняется. Сила: 1 — мягко, 2 — средне, 3 — сильно. */
function fftPrep(n) {
  var lev = Math.round(Math.log(n) / Math.LN2), rev = new Uint32Array(n), c = new Float32Array(n / 2), si = new Float32Array(n / 2), i, b;
  for (i = 0; i < n; i++) { var r = 0; for (b = 0; b < lev; b++) r |= ((i >> b) & 1) << (lev - 1 - b); rev[i] = r; }
  for (i = 0; i < n / 2; i++) { c[i] = Math.cos(2 * Math.PI * i / n); si[i] = -Math.sin(2 * Math.PI * i / n); }
  return { n: n, rev: rev, c: c, s: si };
}
function fft(P, re, im, inv) {
  var n = P.n, i, j, t;
  for (i = 0; i < n; i++) { j = P.rev[i]; if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (var size = 2; size <= n; size <<= 1) {
    var half = size >> 1, step = n / size;
    for (i = 0; i < n; i += size) for (j = 0; j < half; j++) {
      var k = j * step, wr = P.c[k], wi = inv ? -P.s[k] : P.s[k], a = i + j, bb = a + half;
      var xr = re[bb] * wr - im[bb] * wi, xi = re[bb] * wi + im[bb] * wr;
      re[bb] = re[a] - xr; im[bb] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
}
function denoise(src, strength) {
  strength = +strength || 0;
  var N = 1024, H = 512;
  if (!strength || src.length < N * 8) return src;
  var d = new Float32Array(src.length + 2 * N); d.set(src, N);
  var P = fftPrep(N), w = new Float32Array(N), i, k, f;
  for (i = 0; i < N; i++) w[i] = Math.sin(Math.PI * (i + 0.5) / N);   // √Ханна: при 50% перекрытии сумма квадратов = 1
  var nF = Math.floor((d.length - N) / H) + 1, e = new Float32Array(nF);
  for (f = 0; f < nF; f++) { var se = 0, o = f * H; for (i = 0; i < N; i++) se += d[o + i] * d[o + i]; e[f] = se; }
  // тихие кадры, но не нули из добавленных краёв
  var idx = []; for (f = 0; f < nF; f++) if (f * H >= N && f * H + N <= N + src.length) idx.push(f);
  if (idx.length < 12) return src;
  idx.sort(function (a, b) { return e[a] - e[b]; });
  var q = idx.slice(0, Math.max(8, Math.floor(idx.length * 0.1)));
  var K = N / 2 + 1, np = new Float64Array(K), re = new Float32Array(N), im = new Float32Array(N);
  q.forEach(function (fr) {
    var o = fr * H; for (var i2 = 0; i2 < N; i2++) { re[i2] = d[o + i2] * w[i2]; im[i2] = 0; }
    fft(P, re, im, false); for (var k2 = 0; k2 < K; k2++) np[k2] += re[k2] * re[k2] + im[k2] * im[k2];
  });
  var ns = new Float64Array(K);
  for (k = 0; k < K; k++) { var acc = 0, cnt = 0; for (var j = -2; j <= 2; j++) if (k + j >= 0 && k + j < K) { acc += np[k + j]; cnt++; } ns[k] = acc / cnt / q.length; }
  var over = [0, 2.5, 3.5, 5][strength] || 3.5, fl = [1, 0.22, 0.12, 0.07][strength] || 0.12;  // −13 / −18 / −23 дБ
  var out = new Float32Array(d.length), g = new Float32Array(K), gs = new Float32Array(K), g2 = new Float32Array(K);
  for (k = 0; k < K; k++) gs[k] = fl;
  for (f = 0; f < nF; f++) {
    var off = f * H;
    for (i = 0; i < N; i++) { re[i] = d[off + i] * w[i]; im[i] = 0; }
    fft(P, re, im, false);
    for (k = 0; k < K; k++) {
      var pw = re[k] * re[k] + im[k] * im[k], x = 1 - over * ns[k] / (pw + 1e-20);
      g[k] = x > fl * fl ? Math.sqrt(x) : fl;
    }
    for (k = 0; k < K; k++) { var a1 = g[k > 0 ? k - 1 : k], a3 = g[k < K - 1 ? k + 1 : k]; g2[k] = 0.25 * a1 + 0.5 * g[k] + 0.25 * a3; }
    for (k = 0; k < K; k++) { var gt = g2[k]; gs[k] = gt > gs[k] ? gs[k] + (gt - gs[k]) * 0.85 : gs[k] * 0.55 + gt * 0.45; }
    for (k = 0; k < K; k++) {
      re[k] *= gs[k]; im[k] *= gs[k];
      if (k > 0 && k < N / 2) { re[N - k] *= gs[k]; im[N - k] *= gs[k]; }
    }
    fft(P, re, im, true);
    for (i = 0; i < N; i++) out[off + i] += re[i] / N * w[i];
  }
  return out.slice(N, N + src.length);
}

/* ---------- основной рендер ---------- */
function* renderGen(msg) {
  var st = msg.settings, tl = buildTimeline(st, msg.order);
  var total = tl.total;
  var from = Math.round((msg.from || 0) * SR);
  var to = msg.len ? Math.min(total, from + Math.round(msg.len * SR)) : total;
  if (from >= total) from = Math.max(0, total - SR * 5);
  var warm = Math.min(from, SR * 2), startS = from - warm, t0 = startS / SR;
  var env = voiceEnvelopes(tl, st);

  // музыкальные слои: создаются только те, у которых громкость больше нуля
  var layers = [];
  function add(vol, mk) { if (+vol > 0) layers.push({ o: mk(), v: +vol / 100 }); }
  add(st.padVol, function () { return new Pad(st, t0); });
  add(st.droneVol, function () { return new Drone(st, t0); });
  add(st.melVol, function () { return new Notes(noteEvents(st, total, 'melody'), st.melInst || 'harp', t0, 31); });
  add(st.bowlVol, function () { return new Bowls(st, t0, total); });
  add(st.chimeVol, function () { return new Notes(noteEvents(st, total, 'chimes'), 'bells', t0, 37); });
  add(st.oceanVol, function () { return new Ocean(11); });
  add(st.rainVol, function () { return new Rain(23); });
  add(st.windVol, function () { return new Wind(41); });
  add(st.streamVol, function () { return new Stream(53); });
  add(st.birdVol, function () { return new Birds(st, t0, total); });
  add(st.cricketVol, function () { return new Crickets(t0); });
  add(st.fireVol, function () { return new Fire(67); });
  add(st.brownVol, function () { return new Brown(71); });
  add(st.hbVol, function () { return new Heart(st, t0); });
  add(st.toneVol, function () { return new Tone(st, t0); });
  add(st.binVol, function () { return new Binaural(st, t0); });
  var NL = layers.length;
  var cust = (CUSTOM && st.customVol > 0) ? CUSTOM : null;
  var hp = new Biquad('hp', 85, 0.707), lpv = new Biquad('lp', 14000, 0.707);
  var rev = st.reverb > 0 ? new Reverb(st.reverbSize == null ? 0.6 : st.reverbSize) : null;

  var cv = st.customVol / 100;
  var music = db2g(st.musicDb + 10), voiceG = db2g(st.voiceDb), duckDepth = 1 - db2g(-st.duckDb);
  var wet = st.reverb / 100 * 1.1, dry = 1 - st.reverb / 100 * 0.25;
  var gateFloor = st.gate ? db2g(-22) : 1;
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
        for (var li = 0; li < NL; li++) if (layers[li].o.control) layers[li].o.control(t);
      }
      var mL = 0, mR = 0;
      for (var lj = 0; lj < NL; lj++) { var ly = layers[lj]; ly.o.tick(tmp); mL += tmp[0] * ly.v; mR += tmp[1] * ly.v; }
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
      if (m.cmd === 'voice') { var vd = m.data; if (m.nr) { try { vd = denoise(m.data, m.nr); } catch (er) { vd = m.data; } } VOICE[m.id] = vd; return; }
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
if (typeof module !== 'undefined') module.exports = { denoise: denoise, render: render, VOICE: VOICE, setCustom: function (c) { CUSTOM = c; }, SR: SR, buildTimeline: buildTimeline };
