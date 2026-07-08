const express = require('express');

function extractTime(datetimeStr) {
  if (!datetimeStr) return null;
  return datetimeStr.split(' ')[1].substring(0, 5);
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function compareSummaries(motor, legacy) {
  return {
    onTime: motor.summary.onTime - legacy.summary.onTime,
    late: motor.summary.late - legacy.summary.late,
    absent: motor.summary.absent - legacy.summary.absent,
    excused: motor.summary.excused - legacy.summary.excused,
    total: motor.summary.total - legacy.summary.total
  };
}

function createMotorLaboralRoutes({ db, attendanceService }) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, service: 'Motor Laboral', version: '0.1.0' });
  });

  router.get('/attendance/:date/compare', async (req, res) => {
    try {
      const { date } = req.params;
      const tenantId = req.query.tenantId !== undefined && req.query.tenantId !== ''
        ? Number(req.query.tenantId)
        : null;

      const motorResult = await attendanceService.calculateDailyAttendance({ date, tenantId });
      const legacyResult = await attendanceService.calculateLegacyAttendance({ date, db });

      res.json({
        date,
        tenantId,
        motor: motorResult,
        legacy: legacyResult,
        differences: compareSummaries(motorResult, legacyResult)
      });
    } catch (err) {
      console.error('Motor Laboral compare error:', err);
      res.status(500).json({ error: 'Error interno al comparar con legacy' });
    }
  });

  router.get('/attendance/:date', async (req, res) => {
    try {
      const { date } = req.params;
      const tenantId = req.query.tenantId !== undefined && req.query.tenantId !== ''
        ? Number(req.query.tenantId)
        : null;
      const templateId = req.query.templateId !== undefined && req.query.templateId !== ''
        ? Number(req.query.templateId)
        : null;

      const result = await attendanceService.calculateDailyAttendance({ date, tenantId, templateId });

      res.json(result);
    } catch (err) {
      console.error('Motor Laboral attendance error:', err);
      res.status(500).json({ error: 'Error interno del Motor Laboral' });
    }
  });

  return router;
}

module.exports = createMotorLaboralRoutes;
