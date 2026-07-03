import { Router } from 'express';
import { authenticate, requireAdmin, requireSuperAdmin } from '../middleware/auth.middleware';
import { getDashboardStats, getEmployees, createEmployee, updateEmployee, resetEmployeePassword, getEmployeeActivity, getReports, exportReport, getAssignees, getAdmins, createAdmin } from '../controllers/admin.controller';

const router = Router();
router.use(authenticate, requireAdmin);

router.get('/dashboard', getDashboardStats);
router.get('/assignees', getAssignees);
router.get('/employees', getEmployees);
router.post('/employees', requireSuperAdmin, createEmployee);
router.put('/employees/:id', updateEmployee);
router.post('/employees/:id/reset-password', resetEmployeePassword);
router.get('/employees/:id/activity', getEmployeeActivity);
router.get('/reports/export', exportReport);
router.get('/reports', getReports);

// Super Admin only — manage department admins
router.get('/admins', requireSuperAdmin, getAdmins);
router.post('/admins', requireSuperAdmin, createAdmin);
router.post('/admins/:id/reset-password', requireSuperAdmin, resetEmployeePassword);
router.put('/admins/:id', requireSuperAdmin, updateEmployee);

export default router;
