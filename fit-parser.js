/**
 * FIT File Parser — Garmin binary format
 * Extracts: heart rate, speed/pace, distance, altitude, power, timestamps
 * Supports: running, cycling, strength, generic activities
 */
'use strict';

const FIT = (() => {
  // FIT global message numbers we care about
  const MSG = { FILE_ID:0, RECORD:20, SESSION:18, LAP:19, ACTIVITY:34, HRV:78, MONITORING:55, SLEEP_LEVEL:275 };

  // FIT base types
  const BASE = {
    0x00:{size:1,read:(v,o)=>v.getUint8(o)},
    0x01:{size:1,read:(v,o)=>v.getInt8(o)},
    0x02:{size:2,read:(v,o)=>v.getUint16(o,true)},
    0x83:{size:2,read:(v,o)=>v.getInt16(o,true)},
    0x04:{size:4,read:(v,o)=>v.getUint32(o,true)},
    0x85:{size:4,read:(v,o)=>v.getInt32(o,true)},
    0x07:{size:1,read:(v,o)=>v.getUint8(o)}, // byte
    0x0D:{size:1,read:(v,o)=>v.getUint8(o)}, // byte array
    0x88:{size:4,read:(v,o)=>v.getFloat32(o,true)},
    0x89:{size:8,read:(v,o)=>v.getFloat64(o,true)},
    0x8A:{size:1,read:(v,o)=>v.getUint8(o)},  // uint8z
    0x8B:{size:2,read:(v,o)=>v.getUint16(o,true)}, // uint16z
    0x8C:{size:4,read:(v,o)=>v.getUint32(o,true)}, // uint32z
    0x0E:{size:13,read:(v,o)=>{ let s=''; for(let i=0;i<13;i++){const c=v.getUint8(o+i); if(c===0)break; s+=String.fromCharCode(c);} return s; }}, // string
    0x8E:{size:8,read:(v,o)=>v.getBigUint64(o,true)},
  };

  const INVALID = {
    0x00:0xFF, 0x01:0x7F, 0x02:0xFFFF, 0x83:0x7FFF,
    0x04:0xFFFFFFFF, 0x85:0x7FFFFFFF, 0x88:null, 0x89:null,
    0x07:0xFF, 0x0D:0xFF, 0x8A:0, 0x8B:0, 0x8C:0,
  };

  // FIT epoch offset (seconds from Unix epoch to Dec 31, 1989)
  const FIT_EPOCH = 631065600;

  function parse(buffer) {
    const view = new DataView(buffer);
    let offset = 0;

    // Header
    const headerSize = view.getUint8(0);
    const protocol = view.getUint8(1);
    const profileVersion = view.getUint16(2, true);
    const dataSize = view.getUint32(4, true);
    const magic = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (magic !== '.FIT') throw new Error('Not a valid FIT file');

    offset = headerSize;
    const localMsgDefs = {};

    const records = [];
    const sessions = [];
    const laps = [];
    const hrData = [];
    const monitoring = [];

    const endOffset = headerSize + dataSize;

    while (offset < endOffset - 1) {
      const recordHeader = view.getUint8(offset++);
      const isDefinition = (recordHeader & 0x40) !== 0;
      const hasDevData = (recordHeader & 0x20) !== 0;
      const localMsgNum = recordHeader & 0x0F;

      if (isDefinition) {
        offset++; // reserved
        const arch = view.getUint8(offset++);
        const littleEndian = arch === 0;
        const globalMsgNum = view.getUint16(offset, littleEndian); offset += 2;
        const numFields = view.getUint8(offset++);
        const fields = [];
        for (let i = 0; i < numFields; i++) {
          const fieldNum = view.getUint8(offset++);
          const size = view.getUint8(offset++);
          const baseType = view.getUint8(offset++);
          fields.push({ fieldNum, size, baseType });
        }
        let devFields = [];
        if (hasDevData) {
          const numDevFields = view.getUint8(offset++);
          for (let i = 0; i < numDevFields; i++) {
            const fieldNum = view.getUint8(offset++);
            const size = view.getUint8(offset++);
            offset++; // dev data index
            devFields.push({ fieldNum, size, baseType: 0x07 });
          }
        }
        localMsgDefs[localMsgNum] = { globalMsgNum, littleEndian, fields, devFields };
      } else {
        const def = localMsgDefs[localMsgNum];
        if (!def) { offset++; continue; }
        
        const msgStart = offset;
        const data = {};
        
        for (const field of def.fields) {
          const bt = BASE[field.baseType] || BASE[0x00];
          const invalid = INVALID[field.baseType];
          try {
            if (bt.size && field.size === bt.size) {
              const val = bt.read(view, offset);
              data[field.fieldNum] = (invalid !== undefined && val === invalid) ? null : val;
            } else if (field.size > 1 && bt.size === 1) {
              // Array of bytes
              const arr = [];
              for (let i = 0; i < field.size; i++) arr.push(view.getUint8(offset + i));
              data[field.fieldNum] = arr;
            } else {
              data[field.fieldNum] = null;
            }
          } catch(e) { data[field.fieldNum] = null; }
          offset += field.size;
        }
        for (const f of (def.devFields || [])) { offset += f.size; }

        // Parse known messages
        const gNum = def.globalMsgNum;

        if (gNum === MSG.RECORD) {
          // timestamp=253, hr=3, speed=6, distance=5, altitude=2, power=7, cadence=4, lat=0, lon=1
          const ts = data[253] ? data[253] + FIT_EPOCH : null;
          const rec = {
            timestamp: ts ? ts * 1000 : null,
            hr: data[3],
            speed: data[6] != null ? data[6] / 1000 : null, // m/s
            distance: data[5] != null ? data[5] / 100 : null, // m
            altitude: data[2] != null ? (data[2] / 5) - 500 : null, // m
            power: data[7],
            cadence: data[4],
            lat: data[0] != null ? data[0] * (180 / Math.pow(2, 31)) : null,
            lon: data[1] != null ? data[1] * (180 / Math.pow(2, 31)) : null,
          };
          if (rec.hr || rec.speed !== null) hrData.push(rec);
        }

        if (gNum === MSG.SESSION) {
          // sport=5, total_elapsed_time=7, total_distance=9, avg_hr=16, max_hr=17,
          // avg_speed=14, total_calories=11, timestamp=253, start_time=2, training_stress_score=48
          sessions.push({
            timestamp: data[253] ? (data[253] + FIT_EPOCH) * 1000 : null,
            startTime: data[2] ? (data[2] + FIT_EPOCH) * 1000 : null,
            sport: data[5],
            subSport: data[6],
            totalTime: data[7] != null ? data[7] / 1000 : null, // seconds
            totalDistance: data[9] != null ? data[9] / 100 : null, // meters
            avgHR: data[16],
            maxHR: data[17],
            avgSpeed: data[14] != null ? data[14] / 1000 : null, // m/s
            totalCalories: data[11],
            tss: data[48], // Training Stress Score
            totalAscent: data[22],
            avgCadence: data[18],
            avgPower: data[20],
          });
        }

        if (gNum === MSG.LAP) {
          laps.push({
            timestamp: data[253] ? (data[253] + FIT_EPOCH) * 1000 : null,
            totalTime: data[7] != null ? data[7] / 1000 : null,
            totalDistance: data[9] != null ? data[9] / 100 : null,
            avgHR: data[16],
            maxHR: data[17],
            avgSpeed: data[14] != null ? data[14] / 1000 : null,
          });
        }

        if (gNum === MSG.MONITORING) {
          monitoring.push({
            timestamp: data[253] ? (data[253] + FIT_EPOCH) * 1000 : null,
            steps: data[1],
            calories: data[2],
            distance: data[5] != null ? data[5] / 100 : null,
            activityType: data[24],
          });
        }
      }
    }

    return { sessions, laps, hrData, monitoring };
  }

  // Compute HR zones from raw HR data (given max HR)
  function computeHRZones(hrData, maxHR) {
    const zones = [0, 0, 0, 0, 0]; // Z1-Z5
    const boundaries = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    let total = 0;
    hrData.forEach(r => {
      if (!r.hr) return;
      const pct = r.hr / maxHR;
      total++;
      for (let z = 0; z < 5; z++) {
        if (pct >= boundaries[z] && pct < boundaries[z + 1]) { zones[z]++; break; }
        if (z === 4 && pct >= boundaries[4]) zones[4]++;
      }
    });
    return zones.map(z => total ? Math.round(z / total * 100) : 0);
  }

  // Compute pace stats from speed data
  function computePaceStats(hrData) {
    const speeds = hrData.filter(r => r.speed && r.speed > 0.5).map(r => r.speed);
    if (!speeds.length) return null;
    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const avgPaceSecPerKm = 1000 / avgSpeed;
    const minSpeed = Math.max(...speeds);
    const maxPaceSecPerKm = 1000 / minSpeed;
    return {
      avgPaceSecPerKm,
      avgPaceStr: formatPace(avgPaceSecPerKm),
      bestPaceStr: formatPace(maxPaceSecPerKm),
    };
  }

  function formatPace(secPerKm) {
    const min = Math.floor(secPerKm / 60);
    const sec = Math.round(secPerKm % 60);
    return `${min}:${sec.toString().padStart(2, '0')}/km`;
  }

  // Sport name from Garmin sport code
  function sportName(code) {
    const sports = {0:'Generic',1:'Running',2:'Cycling',3:'Transition',4:'Fitness Equipment',5:'Swimming',6:'Basketball',7:'Soccer',8:'Tennis',9:'American Football',10:'Training',11:'Walking',12:'Cross Country Skiing',13:'Alpine Skiing',14:'Snowboarding',15:'Rowing',17:'Hiking',19:'Mountaineering',34:'Stand Up Paddleboarding',53:'Strength Training',58:'Cardio',82:'Yoga',87:'Pilates'};
    return sports[code] || `Sport ${code}`;
  }

  function summarize(parsed, maxHR = 185) {
    const { sessions, laps, hrData, monitoring } = parsed;
    const results = [];

    sessions.forEach((s, idx) => {
      const sessionHR = hrData.filter(r => r.timestamp &&
        r.timestamp >= (s.startTime || 0) &&
        r.timestamp <= (s.timestamp || Infinity));

      const hrZones = computeHRZones(sessionHR, maxHR);
      const paceStats = computePaceStats(sessionHR);

      // Determine EF vs interval from HR zones
      let sessionType = 'unknown';
      if (hrZones[0] + hrZones[1] > 70) sessionType = 'ef'; // >70% en Z1-Z2
      else if (hrZones[3] + hrZones[4] > 20) sessionType = 'interval'; // >20% en Z4-Z5
      else sessionType = 'tempo';

      // Achille risk proxy: high intensity + duration
      const durationMin = (s.totalTime || 0) / 60;
      const achilleRisk = durationMin > 40 && (hrZones[3] + hrZones[4]) > 15 ? 'elevated' :
                          durationMin > 60 ? 'moderate' : 'low';

      results.push({
        sport: sportName(s.sport),
        sportCode: s.sport,
        date: s.startTime ? new Date(s.startTime).toISOString().slice(0, 10) : null,
        durationMin: Math.round(durationMin),
        distanceKm: s.totalDistance ? Math.round(s.totalDistance / 10) / 100 : null,
        avgHR: s.avgHR,
        maxHR: s.maxHR,
        calories: s.totalCalories,
        hrZones,
        paceStats,
        sessionType,
        achilleRisk,
        tss: s.tss,
        avgPower: s.avgPower,
        laps: laps.slice(idx * 2, (idx + 1) * 2), // rough lap association
      });
    });

    return results;
  }

  return { parse, summarize, sportName };
})();

// Export for use in main app
if (typeof window !== 'undefined') window.FITParser = FIT;
