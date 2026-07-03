const express = require('express');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // HELPERS
  // ==========================
  function extractTime(datetimeStr) {
    if (!datetimeStr) return null;
    return datetimeStr.split(' ')[1].substring(0, 5);
  }

  function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  }

  // ==========================
  // 4. LISTA DE ASISTENCIA
  // ==========================
  router.get('/:date', async (req, res) => {
    try {
      const { date } = req.params;
      const { month, scheduleTime, tolerance } = req.query;

      const queryDate =
        date ||
        (month
          ? `${month}-01`
          : new Date().toISOString().slice(0, 10));

      // CONFIG DÍA
      const [dayConfig] = await db.query(
        `SELECT * FROM companyschedule WHERE scheduleDate = ?`,
        [queryDate]
      );

      const config = dayConfig[0] || {
        timeEntrance: scheduleTime || '07:00:00',
        timeExit: '13:40:00',
        isWorkDay: true,
      };

      const [holidayRows] = await db.query(
        `SELECT * FROM holidays
         WHERE date = ?
            OR (recurring = 1 AND DATE_FORMAT(date, '%m-%d') = DATE_FORMAT(?, '%m-%d'))`,
        [queryDate, queryDate]
      );

      if (holidayRows.length > 0) {
        const holidayNotWork = holidayRows.some((h) => h.isWorkDay == 0);
        if (holidayNotWork) {
          config.isWorkDay = false;
        }
      }

      if (!config.isWorkDay) {
        return res.json({
          date: queryDate,
          message: 'No es día laboral',
          schedule: config,
          holidays: holidayRows,
          summary: {
            onTime: 0,
            late: 0,
            absent: 0,
            excused: 0,
            total: 0,
          },
          attendance: [],
        });
      }

      // EXCLUSIONES
      const [exclusions] = await db.query(
        `SELECT * FROM userexclusions WHERE excDate = ?`,
        [queryDate]
      );

      // 🔥 QUERY PRINCIPAL CORRECTA
      const [rows] = await db.query(
        `
        SELECT 
          e.employee_id,
          e.nombre,
          u.USERID,
          u.Badgenumber,
          u.Name,
          c.CHECKTIME
        FROM employees e

        LEFT JOIN user_employee_map ue 
          ON ue.employee_id = e.id

        LEFT JOIN users u 
          ON u.USERID = ue.USERID

        LEFT JOIN Checkins c 
          ON c.USERID = u.USERID
          AND DATE(c.CHECKTIME) = ?

        WHERE (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)

        ORDER BY e.nombre, c.CHECKTIME
      `,
        [queryDate]
      );

      // AGRUPAR CHECKINS
      const map = {};

      rows.forEach((r) => {
        if (!map[r.employee_id]) {
          map[r.employee_id] = {
            userId: r.USERID,
            badgeNumber: r.Badgenumber,
            name: r.nombre,  // ✅ Siempre usa employees.nombre
            checkins: [],
          };
        }

        if (r.CHECKTIME) {
          map[r.employee_id].checkins.push(r.CHECKTIME);
        }
      });

      // ARMAR RESPUESTA
      const attendance = Object.values(map).map((u) => {
        const exclusion = exclusions.find(
          (e) => e.userId === u.userId
        );

        const checkins = u.checkins || [];

        let status = 'Absent';
        let firstCheckin = null;
        let lastCheckin = null;

        if (exclusion) {
          status = 'Excused';
        } else if (checkins.length > 0) {
          firstCheckin = checkins[0];
          lastCheckin = checkins[checkins.length - 1];

          const firstTime = extractTime(firstCheckin);
          const firstMinutes = timeToMinutes(firstTime);

          const toleranceMin = parseInt(tolerance || 10);

          status =
            firstMinutes <=
            timeToMinutes(config.timeEntrance) + toleranceMin
              ? 'OnTime'
              : 'Late';
        }

        return {
          userId: u.userId,
          badgeNumber: u.badgeNumber,
          name: u.name,
          status,
          firstCheckin,
          lastCheckin,
          totalCheckins: checkins.length,
          checkins,
          exclusion: exclusion || null,
        };
      });

      // RESUMEN
      const summary = {
        onTime: attendance.filter((a) => a.status === 'OnTime').length,
        late: attendance.filter((a) => a.status === 'Late').length,
        absent: attendance.filter((a) => a.status === 'Absent').length,
        excused: attendance.filter((a) => a.status === 'Excused').length,
        total: attendance.length,
      };

      res.json({
        date: queryDate,
        schedule: config,
        summary,
        attendance,
      });
    } catch (err) {
      console.error('ERROR fetching attendance:', err);
      if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({ 
          error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
        });
      }
      res.status(500).json({ error: 'Error fetching attendance' });
    }
  });

  // ==========================
  // 5. MOVIMIENTOS (CORREGIDO)
  // ==========================
  router.get('/movements/:date', async (req, res) => {
    try {
      const { date } = req.params;

      const [specialUsers] = await db.query(
        `SELECT * FROM specialusers WHERE isActive = TRUE`
      );

      const markerMap = {};
      specialUsers.forEach((su) => {
        markerMap[su.userId] = {
          category: su.category,
          function: su.function,
        };
      });

      // 🔥 TAMBIÉN CORREGIDO CON MAP
      const [checkins] = await db.query(
        `
        SELECT 
          c.USERID, 
          c.CHECKTIME, 
          e.nombre,
          u.Badgenumber
        FROM Checkins c

        LEFT JOIN users u 
          ON u.USERID = c.USERID

        LEFT JOIN user_employee_map ue 
          ON ue.USERID = u.USERID

        LEFT JOIN employees e 
          ON e.id = ue.employee_id

        WHERE DATE(c.CHECKTIME) = ?
          AND (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)

        ORDER BY c.CHECKTIME
      `,
        [date]
      );

      const movements = [];

      for (let i = 0; i < checkins.length - 1; i++) {
        const current = checkins[i];
        const marker = markerMap[current.USERID];

        if (!marker) continue;

        if (
          marker.category === 'SALIDA' ||
          marker.category === 'RETORNO'
        ) {
          const next = checkins[i + 1];

          if (!markerMap[next.USERID]) {
            movements.push({
              type: marker.category,
              function: marker.function,
              employee: next.nombre,
              employeeBadge: next.Badgenumber,
              timeOut: current.CHECKTIME,
              timeIn:
                i + 2 < checkins.length
                  ? checkins[i + 2].CHECKTIME
                  : null,
            });
          }
        }
      }

      res.json({ date, movements });
    } catch (err) {
      console.error('ERROR fetching movements:', err);
      if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({ 
          error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
        });
      }
      res.status(500).json({ error: 'Error fetching movements' });
    }
  });

  return router;
};