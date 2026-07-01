import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth.middleware';
import { io } from '../index';
import { emitToUser } from '../services/socket.service';

const prisma = new PrismaClient();

// ── Dashboard Stats ──────────────────────────────────────────────
export async function getDashboardStats(req: AuthRequest, res: Response) {
  try {
    const now = new Date();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const [totalEmployees, totalTasks, completedToday] = await Promise.all([
      prisma.user.count({ where: { role: 'EMPLOYEE', isActive: true } }),
      prisma.task.count(),
      prisma.task.count({ where: { status: 'COMPLETED', completedAt: { gte: todayStart, lte: todayEnd } } }),
    ]);
    const overdue = await prisma.task.count({ where: { status: { not: 'COMPLETED' }, dueAt: { lt: now } } });

    // Weekly chart (last 7 days)
    const last7 = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i)); d.setHours(0, 0, 0, 0); return d;
    });
    const weeklyChart = await Promise.all(last7.map(async (day) => {
      const next = new Date(day); next.setDate(next.getDate() + 1);
      const [completed, assigned] = await Promise.all([
        prisma.task.count({ where: { completedAt: { gte: day, lt: next } } }),
        prisma.task.count({ where: { createdAt: { gte: day, lt: next } } }),
      ]);
      return { day: day.toLocaleDateString('en-US', { weekday: 'short' }), completed, assigned };
    }));

    // Priority breakdown
    const priorityBreakdown = await Promise.all(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map(async (p) => ({
      priority: p,
      count: await prisma.task.count({ where: { priority: p as any } }),
    })));

    // Status distribution
    const statusDistribution = await Promise.all(['NOT_STARTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'COMPLETED'].map(async (s) => ({
      status: s,
      count: await prisma.task.count({ where: { status: s as any } }),
    })));
    statusDistribution.push({ status: 'OVERDUE', count: overdue });

    // Top employees by completion rate
    const employees = await prisma.user.findMany({
      where: { role: 'EMPLOYEE', isActive: true },
      select: { id: true, firstName: true, lastName: true, username: true },
    });
    const topEmployees = (await Promise.all(employees.map(async (emp) => {
      const [totalTasks, completedTasks] = await Promise.all([
        prisma.task.count({ where: { assignedToId: emp.id } }),
        prisma.task.count({ where: { assignedToId: emp.id, status: 'COMPLETED' } }),
      ]);
      return { ...emp, totalTasks, completedTasks, score: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0 };
    }))).sort((a, b) => b.score - a.score);

    res.json({ stats: { totalEmployees, totalTasks, completedToday, overdue }, weeklyChart, priorityBreakdown, statusDistribution, topEmployees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
}

// ── Employee CRUD ────────────────────────────────────────────────
export async function getEmployees(req: AuthRequest, res: Response) {
  try {
    const { search, isActive } = req.query;
    const employees = await prisma.user.findMany({
      where: {
        role: 'EMPLOYEE',
        ...(isActive !== undefined && { isActive: isActive === 'true' }),
        ...(search && {
          OR: [
            { firstName: { contains: search as string, mode: 'insensitive' } },
            { lastName: { contains: search as string, mode: 'insensitive' } },
            { username: { contains: search as string, mode: 'insensitive' } },
            { email: { contains: search as string, mode: 'insensitive' } },
          ],
        }),
      },
      select: { id: true, username: true, email: true, firstName: true, lastName: true, phone: true, isActive: true, lastLogin: true, createdAt: true, mustChangePassword: true, _count: { select: { assignedTasks: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const enriched = await Promise.all(employees.map(async (emp) => {
      const completedTasks = await prisma.task.count({ where: { assignedToId: emp.id, status: 'COMPLETED' } });
      return { ...emp, completedTasks };
    }));

    res.json({ employees: enriched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
}

export async function createEmployee(req: AuthRequest, res: Response) {
  try {
    const { username, email, firstName, lastName, phone, password, department, position } = req.body;
    if (!username || !email || !firstName || !lastName) return res.status(400).json({ error: 'Missing required fields' });

    const defaultPassword = password || 'Employee@123';
    const hash = await bcrypt.hash(defaultPassword, 12);

    const employee = await prisma.user.create({
      data: { username: username.toLowerCase(), email: email.toLowerCase(), passwordHash: hash, firstName, lastName, phone, role: 'EMPLOYEE', mustChangePassword: true },
      select: { id: true, username: true, email: true, firstName: true, lastName: true, phone: true, isActive: true, createdAt: true },
    });

    await prisma.activityLog.create({
      data: { action: 'EMPLOYEE_CREATED', description: `Admin created employee ${username}`, userId: req.user!.id },
    });

    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
    for (const admin of admins) {
      const notif = await prisma.notification.create({
        data: { type: 'EMPLOYEE_CREATED', title: 'New Employee Created', message: `${firstName} ${lastName} has been added to the system`, recipientId: admin.id, senderId: req.user!.id },
      });
      emitToUser(io, admin.id, 'notification', notif);
    }

    res.status(201).json({ employee, defaultPassword });
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: 'Failed to create employee' });
  }
}

export async function updateEmployee(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const { firstName, lastName, phone, email, isActive } = req.body;
    const employee = await prisma.user.update({
      where: { id, role: 'EMPLOYEE' },
      data: { ...(firstName && { firstName }), ...(lastName && { lastName }), ...(phone !== undefined && { phone }), ...(email && { email }), ...(isActive !== undefined && { isActive }) },
      select: { id: true, username: true, email: true, firstName: true, lastName: true, phone: true, isActive: true },
    });
    res.json(employee);
  } catch {
    res.status(500).json({ error: 'Failed to update employee' });
  }
}

export async function resetEmployeePassword(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const tempPassword = 'Reset@' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const hash = await bcrypt.hash(tempPassword, 12);
    await prisma.user.update({ where: { id }, data: { passwordHash: hash, mustChangePassword: true } });
    await prisma.activityLog.create({ data: { action: 'PASSWORD_RESET', description: `Admin reset password for employee ${id}`, userId: req.user!.id } });
    res.json({ tempPassword, message: 'Password reset. Employee must change on next login.' });
  } catch {
    res.status(500).json({ error: 'Failed to reset password' });
  }
}

export async function getEmployeeActivity(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const logs = await prisma.activityLog.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { task: { select: { id: true, title: true } } },
    });
    res.json(logs);
  } catch {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
}

export async function getReports(req: AuthRequest, res: Response) {
  try {
    const { period = 'weekly' } = req.query;
    const now = new Date();
    let from: Date;
    if (period === 'daily') { from = new Date(now); from.setHours(0, 0, 0, 0); }
    else if (period === 'monthly') { from = new Date(now.getFullYear(), now.getMonth(), 1); }
    else { from = new Date(now); from.setDate(now.getDate() - 7); }

    const [tasks, employees] = await Promise.all([
      prisma.task.findMany({ where: { createdAt: { gte: from } } }),
      prisma.user.findMany({ where: { role: 'EMPLOYEE', isActive: true }, select: { id: true, firstName: true, lastName: true } }),
    ]);

    const totalCompleted = tasks.filter(t => t.status === 'COMPLETED').length;
    const totalOverdue = tasks.filter(t => t.status !== 'COMPLETED' && t.dueAt < now).length;
    const completionRate = tasks.length > 0 ? Math.round((totalCompleted / tasks.length) * 100) : 0;

    // Chart data (daily breakdown over period)
    const days = period === 'daily' ? 1 : period === 'monthly' ? 30 : 7;
    const chart = await Promise.all(Array.from({ length: days }, (_, i) => {
      const day = new Date(from); day.setDate(day.getDate() + i); day.setHours(0, 0, 0, 0);
      const next = new Date(day); next.setDate(next.getDate() + 1);
      const dayTasks = tasks.filter(t => t.createdAt >= day && t.createdAt < next);
      return {
        label: day.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        assigned: dayTasks.length,
        completed: dayTasks.filter(t => t.status === 'COMPLETED').length,
      };
    }));

    const employeePerformance = await Promise.all(employees.map(async (emp) => {
      const empTasks = tasks.filter(t => t.assignedToId === emp.id);
      return {
        ...emp,
        totalAssigned: empTasks.length,
        completed: empTasks.filter(t => t.status === 'COMPLETED').length,
        overdue: empTasks.filter(t => t.status !== 'COMPLETED' && t.dueAt < now).length,
      };
    }));

    res.json({ summary: { totalAssigned: tasks.length, totalCompleted, totalOverdue, completionRate }, chart, employeePerformance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
}

export async function exportReport(req: AuthRequest, res: Response) {
  try {
    const { period = 'weekly', format = 'csv' } = req.query;
    const now = new Date();
    let from: Date;
    if (period === 'daily') { from = new Date(now); from.setHours(0, 0, 0, 0); }
    else if (period === 'monthly') { from = new Date(now.getFullYear(), now.getMonth(), 1); }
    else { from = new Date(now); from.setDate(now.getDate() - 7); }

    const tasks = await prisma.task.findMany({
      where: { createdAt: { gte: from } },
      include: { assignedTo: { select: { firstName: true, lastName: true, username: true } } },
      orderBy: { createdAt: 'desc' },
    });

    if (format === 'csv') {
      const header = 'Title,Assigned To,Priority,Status,Due Date,Completed At\n';
      const rows = tasks.map(t => [
        `"${t.title}"`,
        `"${t.assignedTo ? t.assignedTo.firstName + ' ' + t.assignedTo.lastName : ''}"`,
        t.priority, t.status,
        new Date(t.dueAt).toLocaleDateString(),
        t.completedAt ? new Date(t.completedAt).toLocaleDateString() : '',
      ].join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="report-${period}.csv"`);
      return res.send(header + rows);
    }

    // Fallback JSON for other formats
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
}
