/**
 * Garmin Sync Module
 * Three data sources:
 *  1. FIT file import (from USB/device)
 *  2. Garmin Connect JSON export (health data)
 *  3. Unofficial Garmin API (auto-sync, ToS risk)
 */
'use strict';

const GarminSync = (() => {

  // ── STORAGE ──────────────────────────────────────────────────
  const DB_KEY = 'garmin_data';
  const API_KEY = 'garmin_api_creds';

  function getData() {
    try { return JSON.parse(localStorage.getItem(DB_KEY) || '{"activities":[],"health":[],"lastSync":null}'); }
    catch { return { activities: [], health: [], lastSync: null }; }
  }
  function saveData(d) { localStorage.setItem(DB_KEY, JSON.stringify(d)); }
  function getCreds() { try { return JSON.parse(localStorage.getItem(API_KEY) || 'null'); } catch { return null; } }
  function saveCreds(c) { localStorage.setItem(API_KEY, JSON.stringify(c)); }

  // ── METHOD 1: FIT FILE IMPORT ─────────────────────────────────
  async function importFITFile(file, maxHR = 185) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = window.FITParser.parse(e.target.result);
          const activities = window.FITParser.summarize(parsed, maxHR);
          // Merge into stored data
          const db = getData();
          activities.forEach(act => {
            const exists = db.activities.find(a => a.date === act.date && a.sport === act.sport && a.durationMin === act.durationMin);
            if (!exists) db.activities.push({ ...act, source: 'fit', importedAt: new Date().toISOString() });
          });
          db.lastSync = new Date().toISOString();
          saveData(db);
          resolve({ success: true, count: activities.length, activities });
        } catch (err) {
          reject(new Error('Fichier FIT invalide : ' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('Lecture du fichier échouée'));
      reader.readAsArrayBuffer(file);
    });
  }

  // ── METHOD 2: GARMIN CONNECT JSON EXPORT ─────────────────────
  // Supports multiple Garmin export formats
  async function importGarminJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const raw = JSON.parse(e.target.result);
          const db = getData();
          let imported = 0;

          // Format 1: Activities export (array of activity summaries)
          if (Array.isArray(raw)) {
            raw.forEach(item => {
              // Activity format
              if (item.activityType || item.activityName) {
                const act = parseGarminActivityJSON(item);
                if (act && !db.activities.find(a => a.date === act.date && a.garminId === act.garminId)) {
                  db.activities.push({ ...act, source: 'json' });
                  imported++;
                }
              }
              // Health/wellness format
              if (item.calendarDate || item.summaryDate) {
                const health = parseGarminHealthJSON(item);
                if (health && !db.health.find(h => h.date === health.date)) {
                  db.health.push({ ...health, source: 'json' });
                  imported++;
                }
              }
            });
          }

          // Format 2: Single activity detail
          if (raw.activityId || raw.summaryDTO) {
            const act = parseGarminActivityDetail(raw);
            if (act) { db.activities.push({ ...act, source: 'json' }); imported++; }
          }

          // Format 3: Wellness/sleep/daily data
          if (raw.dailySummaries || raw.sleepData || raw.wellnessData) {
            const healthItems = parseGarminWellnessExport(raw);
            healthItems.forEach(h => {
              if (!db.health.find(x => x.date === h.date)) {
                db.health.push({ ...h, source: 'json' });
                imported++;
              }
            });
          }

          // Format 4: Sleep export
          if (raw.sleepStartTimestampGMT || raw.dailySleepDTO) {
            const sleep = parseGarminSleepJSON(raw);
            if (sleep) {
              const existing = db.health.find(h => h.date === sleep.date);
              if (existing) Object.assign(existing, sleep);
              else db.health.push({ ...sleep, source: 'json' });
              imported++;
            }
          }

          db.lastSync = new Date().toISOString();
          saveData(db);
          resolve({ success: true, count: imported });
        } catch (err) {
          reject(new Error('JSON invalide : ' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('Lecture échouée'));
      reader.readAsText(file);
    });
  }

  function parseGarminActivityJSON(item) {
    const typeMap = { 'running': 'Running', 'cycling': 'Cycling', 'strength_training': 'Strength Training', 'cardio_training': 'Cardio', 'walking': 'Walking', 'swimming': 'Swimming' };
    const type = item.activityType?.typeKey || item.activityType || 'unknown';
    return {
      garminId: item.activityId || item.activitySummary?.activityId,
      date: item.startTimeLocal?.slice(0, 10) || item.beginTimestamp?.slice(0, 10),
      sport: typeMap[type] || type,
      durationMin: item.duration ? Math.round(item.duration / 60) : (item.elapsedDuration ? Math.round(item.elapsedDuration / 60) : null),
      distanceKm: item.distance ? Math.round(item.distance / 10) / 100 : null,
      avgHR: item.averageHR || item.averageHeartRate,
      maxHR: item.maxHR || item.maxHeartRate,
      calories: item.calories || item.activeCalories,
      avgPace: item.averageSpeed ? formatPace(1000 / item.averageSpeed) : null,
      tss: item.trainingStressScore,
      aerobicTE: item.aerobicTrainingEffect,
      anaerobicTE: item.anaerobicTrainingEffect,
      recoveryTime: item.recoveryTime, // hours
      name: item.activityName,
    };
  }

  function parseGarminActivityDetail(raw) {
    const s = raw.summaryDTO || raw;
    return {
      garminId: raw.activityId,
      date: s.startTimeLocal?.slice(0, 10),
      sport: raw.activityTypeDTO?.typeKey || 'unknown',
      durationMin: s.elapsedDuration ? Math.round(s.elapsedDuration / 60) : null,
      distanceKm: s.distance ? Math.round(s.distance / 10) / 100 : null,
      avgHR: s.averageHR,
      maxHR: s.maxHR,
      calories: s.calories,
      tss: s.trainingStressScore,
      recoveryTime: s.recoveryTime,
    };
  }

  function parseGarminHealthJSON(item) {
    const date = item.calendarDate || item.summaryDate;
    return {
      date,
      steps: item.totalSteps || item.steps,
      distanceKm: item.totalDistanceMeters ? item.totalDistanceMeters / 1000 : null,
      calories: item.totalKilocalories || item.activeKilocalories,
      restingHR: item.restingHeartRate,
      bodyBattery: {
        high: item.bodyBatteryHighestValue,
        low: item.bodyBatteryLowestValue,
        charged: item.bodyBatteryChargedValue,
        drained: item.bodyBatteryDrainedValue,
      },
      stressAvg: item.averageStressLevel,
      stressMax: item.maxStressLevel,
      intensityMinutes: item.vigorousIntensityMinutes,
      floorsClimbed: item.floorsAscended,
    };
  }

  function parseGarminWellnessExport(raw) {
    const items = raw.dailySummaries || raw.wellnessData || [];
    return items.map(parseGarminHealthJSON).filter(Boolean);
  }

  function parseGarminSleepJSON(raw) {
    const dto = raw.dailySleepDTO || raw;
    const date = raw.calendarDate || dto.calendarDate;
    if (!date) return null;
    return {
      date,
      sleep: {
        durationMin: dto.sleepTimeSeconds ? Math.round(dto.sleepTimeSeconds / 60) : null,
        deepMin: dto.deepSleepSeconds ? Math.round(dto.deepSleepSeconds / 60) : null,
        remMin: dto.remSleepSeconds ? Math.round(dto.remSleepSeconds / 60) : null,
        lightMin: dto.lightSleepSeconds ? Math.round(dto.lightSleepSeconds / 60) : null,
        awakeMin: dto.awakeSleepSeconds ? Math.round(dto.awakeSleepSeconds / 60) : null,
        score: dto.sleepScores?.overall?.value || dto.overallSleepScore,
        startTime: raw.sleepStartTimestampLocal,
        endTime: raw.sleepEndTimestampLocal,
        avgHRV: dto.avgSleepStress ? Math.round(100 - dto.avgSleepStress) : null, // proxy
        hrv: raw.hrv?.hrvSummary?.lastNight,
      },
    };
  }

  // ── METHOD 3: UNOFFICIAL API ──────────────────────────────────
  // ⚠️ Uses unofficial endpoints — may break, violates Garmin ToS
  // Proxied through a CORS proxy since Garmin doesn't support CORS

  const PROXY = 'https://corsproxy.io/?'; // fallback proxy
  const GC_BASE = 'https://connect.garmin.com';

  async function apiLogin(username, password) {
    // Note: Garmin uses a complex SSO flow. We simulate it.
    // This uses the same flow as garminconnect Python library
    const ssoUrl = 'https://sso.garmin.com/sso/signin';
    
    try {
      // Step 1: Get CSRF token
      const initRes = await fetch(PROXY + encodeURIComponent(`${ssoUrl}?service=https://connect.garmin.com/modern/`));
      const html = await initRes.text();
      const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
      const csrf = csrfMatch ? csrfMatch[1] : '';

      // Step 2: POST credentials
      const formData = new URLSearchParams({
        username, password, embed: 'false', _csrf: csrf,
        service: 'https://connect.garmin.com/modern/',
      });

      const loginRes = await fetch(PROXY + encodeURIComponent(ssoUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData,
        credentials: 'include',
      });

      if (!loginRes.ok) throw new Error('Connexion échouée');

      // Store session indicator (cookies managed by browser)
      saveCreds({ username, loggedIn: true, loginDate: new Date().toISOString() });
      return { success: true };
    } catch (e) {
      throw new Error('Login Garmin échoué : ' + e.message + '\n\nNote: L\'API non-officielle est instable. Utilisez l\'import FIT ou JSON pour une solution fiable.');
    }
  }

  async function apiFetch(endpoint) {
    const url = `${GC_BASE}/proxy/${endpoint}`;
    const res = await fetch(PROXY + encodeURIComponent(url), {
      credentials: 'include',
      headers: { 'NK': 'NT', 'X-app-ver': '4.6.1.4', 'Referer': GC_BASE }
    });
    if (!res.ok) throw new Error(`API error ${res.status} on ${endpoint}`);
    return res.json();
  }

  async function syncActivities(days = 14) {
    const end = new Date();
    const start = new Date(end - days * 86400000);
    const fmt = d => d.toISOString().slice(0, 10);

    // Get activities list
    const activities = await apiFetch(
      `activity-search-service-1.0/json/activities?start=0&limit=50&startDate=${fmt(start)}&endDate=${fmt(end)}`
    );

    const db = getData();
    let count = 0;

    const list = activities.results?.activities || activities.activityList || [];
    for (const raw of list) {
      const act = parseGarminActivityJSON(raw.activity || raw);
      if (act && !db.activities.find(a => a.garminId === act.garminId)) {
        db.activities.push({ ...act, source: 'api' });
        count++;
      }
    }

    // Get daily wellness
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      try {
        const dateStr = fmt(d);
        const wellness = await apiFetch(`wellness-service/wellness/dailySummary/${dateStr}`);
        const health = parseGarminHealthJSON({ ...wellness, calendarDate: dateStr });
        if (health) {
          const ex = db.health.find(h => h.date === dateStr);
          if (ex) Object.assign(ex, health);
          else db.health.push({ ...health, source: 'api' });
        }

        // Sleep
        const sleep = await apiFetch(`wellness-service/wellness/dailySleepData/${dateStr}`);
        const sleepParsed = parseGarminSleepJSON({ ...sleep, calendarDate: dateStr });
        if (sleepParsed) {
          const ex = db.health.find(h => h.date === dateStr);
          if (ex) Object.assign(ex, { sleep: sleepParsed.sleep });
          else db.health.push({ ...sleepParsed, source: 'api' });
        }
      } catch (e) { /* skip days with errors */ }
    }

    db.lastSync = new Date().toISOString();
    saveData(db);
    return { success: true, count };
  }

  // ── ANALYSIS ENGINE ───────────────────────────────────────────
  function analyzeWeek(weekStart, weekEnd) {
    const db = getData();
    const acts = db.activities.filter(a => a.date >= weekStart && a.date <= weekEnd);
    const health = db.health.filter(h => h.date >= weekStart && h.date <= weekEnd);

    // Fatigue score (0-100)
    let fatigueScore = 0;
    const highIntensity = acts.filter(a => a.sport === 'Running' || a.sport === 'Cycling');
    fatigueScore += highIntensity.reduce((s, a) => s + (a.durationMin || 0) * 0.5, 0);
    fatigueScore += acts.reduce((s, a) => s + (a.tss || 0) * 0.3, 0);

    // Sleep debt
    const sleepDays = health.filter(h => h.sleep?.durationMin);
    const avgSleep = sleepDays.length ? sleepDays.reduce((s, h) => s + h.sleep.durationMin, 0) / sleepDays.length : 0;
    const sleepDebt = Math.max(0, 480 - avgSleep); // 8h target
    fatigueScore += sleepDebt * 0.2;

    // Body battery drain
    const bbDays = health.filter(h => h.bodyBattery?.drained);
    const avgDrain = bbDays.length ? bbDays.reduce((s, h) => s + h.bodyBattery.drained, 0) / bbDays.length : 0;
    fatigueScore += avgDrain * 0.5;

    fatigueScore = Math.min(100, Math.round(fatigueScore));

    // Recovery score
    const recoveryScore = Math.max(0, 100 - fatigueScore);

    // Achille risk
    const runningLoad = acts.filter(a => a.sport === 'Running').reduce((s, a) => s + (a.durationMin || 0), 0);
    const padel = acts.filter(a => a.name?.toLowerCase().includes('padel') || a.sport?.toLowerCase().includes('padel'));
    const beach = acts.filter(a => a.name?.toLowerCase().includes('beach') || a.name?.toLowerCase().includes('volley'));
    const highImpactMin = runningLoad + padel.length * 60 + beach.length * 75;
    const achilleRisk = highImpactMin > 180 ? 'ÉLEVÉ' : highImpactMin > 120 ? 'MODÉRÉ' : 'FAIBLE';
    const achilleColor = highImpactMin > 180 ? '#e07070' : highImpactMin > 120 ? '#e07b39' : '#7eb87a';

    // HR zone compliance (for runs)
    const runs = acts.filter(a => a.sport === 'Running' && a.hrZones);
    const efRuns = runs.filter(a => a.sessionType === 'ef');
    const efCompliance = efRuns.length ? Math.round(efRuns.filter(r => (r.hrZones?.[0] || 0) + (r.hrZones?.[1] || 0) > 70).length / efRuns.length * 100) : null;

    return {
      fatigueScore,
      recoveryScore,
      acts,
      health,
      achilleRisk,
      achilleColor,
      highImpactMin,
      avgSleep: avgSleep ? Math.round(avgSleep) : null,
      sleepDebt: Math.round(sleepDebt),
      avgBodyBattery: health.filter(h => h.bodyBattery?.high).length ? Math.round(health.filter(h => h.bodyBattery?.high).reduce((s, h) => s + h.bodyBattery.high, 0) / health.filter(h => h.bodyBattery?.high).length) : null,
      efCompliance,
      totalDurationMin: acts.reduce((s, a) => s + (a.durationMin || 0), 0),
      totalCalories: acts.reduce((s, a) => s + (a.calories || 0), 0),
    };
  }

  // Match Garmin activities to plan sessions
  function matchToPlan(planSessions, garminActs) {
    const matched = [];
    planSessions.forEach(session => {
      // Find Garmin activity on same day with similar type
      const dayActs = garminActs.filter(a => a.date === session.date);
      const typeMatch = {
        'force': ['Strength Training', 'Cardio'],
        'run': ['Running', 'Walking'],
        'cardio': ['Cycling', 'Cardio', 'Spinning'],
        'volley': ['Beach Volleyball', 'Volleyball', 'Other'],
        'mob': ['Yoga', 'Flexibility'],
      };
      const candidates = dayActs.filter(a => (typeMatch[session.type] || []).includes(a.sport));
      if (candidates.length) {
        matched.push({ session, garminAct: candidates[0], status: 'matched' });
      } else if (dayActs.length) {
        matched.push({ session, garminAct: dayActs[0], status: 'partial' });
      } else {
        matched.push({ session, garminAct: null, status: 'missing' });
      }
    });
    return matched;
  }

  function formatPace(s) {
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return `${m}:${sec.toString().padStart(2,'0')}/km`;
  }

  return { importFITFile, importGarminJSON, apiLogin, syncActivities, analyzeWeek, matchToPlan, getData, getCreds, saveCreds };
})();

if (typeof window !== 'undefined') window.GarminSync = GarminSync;
