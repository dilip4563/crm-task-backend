import { Router } from 'express';
import { authenticate, requireAdmin, requireSuperAdmin } from '../middleware/auth.middleware';
import {
  getMyToday, getMyHistory, startBreak, endBreak,
  createCorrection, getMyCorrections, getPendingCorrections, reviewCorrection,
  getAdminOverview, exportAttendance, getWorkSettings, updateWorkSettings,
} from '../controllers/attendance.controller';

const router = Router();
router.use(authenticate);

// self-service (any role)
router.get('/me/today', getMyToday);
router.get('/me/history', getMyHistory);
router.post('/break/start', startBreak);
router.post('/break/end', endBreak);
router.post('/corrections', createCorrection);
router.get('/corrections/mine', getMyCorrections);
router.get('/settings', getWorkSettings);

// admin
router.get('/admin/overview', requireAdmin, getAdminOverview);
router.get('/admin/export', requireAdmin, exportAttendance);
router.get('/corrections/pending', requireAdmin, getPendingCorrections);
router.patch('/corrections/:id', requireAdmin, reviewCorrection);

// super admin
router.put('/settings', requireSuperAdmin, updateWorkSettings);

export default router;
