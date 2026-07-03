const express = require('express');
const createAdminRoutes = require('./routes/admin');
const createAttendanceRoutes = require('./routes/attendance');
const scheduleRepository = require('./repositories/scheduleRepository');
const holidayRepository = require('./repositories/holidayRepository');
const userRepository = require('./repositories/userRepository');
const checkinRepository = require('./repositories/checkinRepository');
const exclusionRepository = require('./repositories/exclusionRepository');
const attendanceService = require('./services/attendanceService');
const { firebaseAuthMiddleware } = require('../firebaseAuth');

function createLaborEngineRoutes(db) {
  const repositories = {
    schedule: {
      findByDate: (date, tenantId) => scheduleRepository.findByDate(date, tenantId, db),
      findAssignedScheduleMapForDate: (date, employeeIds) => scheduleRepository.findAssignedScheduleMapForDate(date, employeeIds, db)
    },
    holiday: {
      findByDate: (date, tenantId) => holidayRepository.findByDate(date, tenantId, db)
    },
    user: {
      findAll: (options) => userRepository.findAll(options, db)
    },
    checkin: {
      findByDate: (date, tenantId) => checkinRepository.findByDate(date, tenantId, db)
    },
    exclusion: {
      findByDate: (date, tenantId) => exclusionRepository.findByDate(date, tenantId, db)
    }
  };

  const service = {
    calculateDailyAttendance: (options) => attendanceService.calculateDailyAttendance({ ...options, repositories }),
    calculateLegacyAttendance: (options) => attendanceService.calculateLegacyAttendance(options)
  };

  const router = express.Router();
  router.use('/', createAttendanceRoutes({ db, attendanceService: service }));
  router.use('/admin', firebaseAuthMiddleware, createAdminRoutes(db));

  return router;
}

module.exports = createLaborEngineRoutes;
