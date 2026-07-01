import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';
import { getDashboardStats, getEmployees, createEmployee, updateEmployee, resetEmployeePassword, getEmployeeActivity, getReports, exportReport } from '../controllers/admin.controller';

const router = Router();
router.use(authenticate, requireAdmin);

router.get('/dashboard', getDashboardStats);
router.get('/employees', getEmployees);
router.post('/employees', createEmployee);
router.put('/employees/:id', updateEmployee);
router.post('/employees/:id/reset-password', resetEmployeePassword);
router.get('/employees/:id/activity', getEmployeeActivity);
router.get('/reports/export', exportReport);
router.get('/reports', getReports);

export default router;
