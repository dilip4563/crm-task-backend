import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { PrismaClient, Prisma } from '@prisma/client';
import { AuthRequest } from '../middleware/auth.middleware';
import { io } from '../index';
import { emitToUser } from '../services/socket.service';

const prisma = new PrismaClient();

const isSuper = (req: AuthRequest) => req.user?.role === 'SUPER_ADMIN';

/** Employees visible to the requester: all for SUPER_ADMIN, own team for ADMIN */
function teamFilter(req: AuthRequest): Prisma.UserWhereInput {
  return isSuper(req) ? { role: 'EMPLOYEE' } : { role: 'EMPLOYEE', managerId: req.user!.id };
}

/** Task scope: everything for SUPER_ADMIN; own team's tasks + own created for ADMIN */
function taskFilter(req: AuthRequest): Prisma.TaskWhereInput {
  return isSuper(req) ? {} : { OR: [{ assignedTo: { managerId: req.user!.id } }, { createdById: req.user!.id }] };
}

// ── Dashboard Stats ──────────────────────────────────────────────
export async function getDashboardStats(req: AuthRequest, res: Response) {
  try {
    const now = new Date();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const tf = taskFilter(req);

    const [totalEmployees, totalTasks, completedToday, overdue] = await Promise.all([
      prisma.user.count({ where: { ...teamFilter(req), isActive: true } }),
      prisma.task.count({ where: tf }),
      prisma.task.count({ where: { ...tf, status: 'COMPLETED', completedAt: { gte: todayStart, lte: todayEnd } } }),
      prisma.task.count({ where: { ...tf, status: { not: 'COMPLETED' }, dueAt: { lt: now } } }),
    ]);

    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6); weekStart.setHours(0, 0, 0, 0);
    const [weekTasks, allTasks, employees] = await Promise.all([
      prisma.task.findMany({ where: { ...tf, OR: [{ createdAt: { gte: weekStart } }, { completedAt: { gte: weekStart } }] }, select: { createdAt: true, completedAt: true } }),
      prisma.task.findMany({ where: tf, select: { priority: true, status: true, assignedToId: true } }),
      prisma.user.findMany({ where: { ...teamFilter(req), isActive: true }, select: { id: true, firstName: true, lastName: true, username: true } }),
    ]);

    const last7 = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i)); d.setHours(0, 0, 0, 0); return d;
    });
    const weeklyChart = last7.map((day) => {
      const next = new Date(day); next.setDate(next.getDate() + 1);
      return {
        day: day.toLocaleDateString('en-US', { weekday: 'short' }),
        completed: weekTasks.filter(t => t.completedAt && t.completedAt >= day && t.completedAt < next).length,
        assigned: weekTasks.filter(t => t.createdAt >= day && t.createdAt < next).length,
      };
    });

    const priorityBreakdown = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map(p => ({
      priority: p, count: allTasks.filter(t => t.priority === p).length,
    }));

    const statusDistribution = ['NOT_STARTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'COMPLETED'].map(s => ({
      status: s, count: allTasks.filter(t => t.status === s).length,
    }));
    statusDistribution.push({ status: 'OVERDUE', count: overdue });

    const topEmployees = employees.map((emp) => {
      const empTasks = allTasks.filter(t => t.assignedToId === emp.id);
      const completedTasks = empTasks.filter(t => t.status === 'COMPLETED').length;
      return { ...emp, totalTasks: empTasks.length, completedTasks, score: empTasks.length > 0 ? Math.round((completedTasks / empTasks.length) * 100) : 0 };
    }).sort((a, b) => b.score - a.score);

    // Live: who is online right now (open attendance session today)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const userScope = isSuper(req) ? { role: { in: ['ADMIN', 'EMPLOYEE'] as any } } : { managerId: req.user!.id };
    const openSessions = await prisma.attendanceSession.findMany({
      where: { date: today, logoutAt: null, user: { ...userScope, isActive: true } },
      include: { user: { select: { id: true, firstName: true, lastName: true, username: true, role: true, department: true } } },
      orderBy: { loginAt: 'asc' },
    });
    const openBreaks = await prisma.breakSession.findMany({ where: { date: today, endAt: null }, select: { userId: true } });
    const breakIds = new Set(openBreaks.map(b => b.userId));
    const seen = new Set<string>();
    const activeNow = openSessions.filter(s => !seen.has(s.userId) && seen.add(s.userId)).map(s => ({
      ...s.user, loginAt: s.loginAt, onBreak: breakIds.has(s.userId),
    }));

    res.json({ stats: { totalEmployees, totalTasks, completedToday, overdue }, weeklyChart, priorityBreakdown, statusDistribution, topEmployees, activeNow });
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
        ...teamFilter(req),
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
      select: { id: true, username: true, email: true, firstName: true, lastName: true, phone: true, department: true, isActive: true, lastLogin: true, createdAt: true, mustChangePassword: true, manager: { select: { firstName: true, lastName: true, department: true } }, _count: { select: { assignedTasks: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const completedGroups = await prisma.task.groupBy({ by: ['assignedToId'], where: { status: 'COMPLETED' }, _count: true });
    const enriched = employees.map((emp) => ({
      ...emp,
      completedTasks: completedGroups.find(g => g.assignedToId === emp.id)?._count ?? 0,
    }));

    res.json({ employees: enriched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
}

function generatePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '@#$!';
  const pick = (set: string, n: number) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');
  return pick(upper, 2) + pick(lower, 4) + pick(digits, 3) + pick(symbols, 1);
}

async function generateUserId(prefix: string, role: 'EMPLOYEE' | 'ADMIN'): Promise<string> {
  const count = await prisma.user.count({ where: { role } });
  let seq = count + 1;
  while (await prisma.user.findUnique({ where: { username: `${prefix}${String(seq).padStart(4, '0')}` } })) seq++;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

export async function createEmployee(req: AuthRequest, res: Response) {
  try {
    const { email, firstName, lastName, phone, managerId } = req.body;
    if (!email || !firstName || !lastName) return res.status(400).json({ error: 'Missing required fields' });

    // ADMIN creates employees under themselves; SUPER_ADMIN can pick a manager (or none)
    let assignedManagerId: string | null = null;
    if (isSuper(req)) {
      assignedManagerId = managerId || null;
    } else {
      assignedManagerId = req.user!.id;
    }

    // Inherit department from manager
    let department: string | null = req.body.department || null;
    if (assignedManagerId && !department) {
      const mgr = await prisma.user.findUnique({ where: { id: assignedManagerId }, select: { department: true } });
      department = mgr?.department || null;
    }

    const username = await generateUserId('emp', 'EMPLOYEE');
    const generatedPassword = generatePassword();
    const hash = await bcrypt.hash(generatedPassword, 12);

    const employee = await prisma.user.create({
      data: { username, email: email.toLowerCase(), passwordHash: hash, firstName, lastName, phone, department, role: 'EMPLOYEE', managerId: assignedManagerId, mustChangePassword: true },
      select: { id: true, username: true, email: true, firstName: true, lastName: true, phone: true, department: true, isActive: true, createdAt: true },
    });

    await prisma.activityLog.create({
      data: { action: 'EMPLOYEE_CREATED', description: `${req.user!.username} created employee ${username}`, userId: req.user!.id },
    });

    // Notify super admins + the manager
    const notifyIds = new Set<string>();
    const supers = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { id: true } });
    supers.forEach(s => notifyIds.add(s.id));
    if (assignedManagerId) notifyIds.add(assignedManagerId);
    notifyIds.delete(req.user!.id);
    for (const id of notifyIds) {
      const notif = await prisma.notification.create({
        data: { type: 'EMPLOYEE_CREATED', title: 'New Employee Created', message: `${firstName} ${lastName} has been added to the system`, recipientId: id, senderId: req.user!.id },
      });
      emitToUser(io, id, 'notification', notif);
    }

    res.status(201).json({ employee, credentials: { userId: username, password: generatedPassword } });
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Email already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create employee' });
  }
}

/** Users the requester is allowed to assign tasks to */
export async function getAssignees(req: AuthRequest, res: Response) {
  try {
    const { search } = req.query;
    const searchFilter = search ? {
      OR: [
        { firstName: { contains: search as string, mode: 'insensitive' as const } },
        { lastName: { contains: search as string, mode: 'insensitive' as const } },
        { username: { contains: search as string, mode: 'insensitive' as const } },
      ],
    } : {};

    const where: Prisma.UserWhereInput = isSuper(req)
      ? { isActive: true, role: { in: ['ADMIN', 'EMPLOYEE'] }, ...searchFilter }
      : { isActive: true, role: 'EMPLOYEE', managerId: req.user!.id, ...searchFilter };

    const assignees = await prisma.user.findMany({
      where,
      select: { id: true, username: true, firstName: true, lastName: true, role: true, department: true },
      orderBy: [{ role: 'asc' }, { firstName: 'asc' }],
      take: 20,
    });
    res.json({ assignees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch assignees' });
  }
}

// ── Admin management (SUPER_ADMIN only) ──────────────────────────
export async function getAdmins(req: AuthRequest, res: Response) {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true, username: true, email: true, firstName: true, lastName: true, phone: true, department: true, isActive: true, lastLogin: true, createdAt: true, _count: { select: { teamMembers: true, assignedTasks: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ admins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch admins' });
  }
}

export async function createAdmin(req: AuthRequest, res: Response) {
  try {
    const { email, firstName, lastName, phone, department } = req.body;
    if (!email || !firstName || !lastName || !department) return res.status(400).json({ error: 'Missing required fields (department is required for admins)' });

    const username = await generateUserId('adm', 'ADMIN');
    const generatedPassword = generatePassword();
    const hash = await bcrypt.hash(generatedPassword, 12);

    const admin = await prisma.user.create({
      data: { username, email: email.toLowerCase(), passwordHash: hash, firstName, lastName, phone, department, role: 'ADMIN', mustChangePassword: true },
      select: { id: true, username: true, email: true, firstName: true, lastName: true, department: true, isActive: true, createdAt: true },
    });

    await prisma.activityLog.create({
      data: { action: 'ADMIN_CREATED', description: `Super admin created admin ${username} (${department})`, userId: req.user!.id },
    });

    res.status(201).json({ admin, credentials: { userId: username, password: generatedPassword } });
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Email already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create admin' });
  }
}

export async function updateEmployee(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const { firstName, lastName, phone, email, isActive, department, managerId } = req.body;

    // Admins can only update their own team members
    if (!isSuper(req)) {
      const target = await prisma.user.findUnique({ where: { id }, select: { managerId: true, role: true } });
      if (!target || target.role !== 'EMPLOYEE' || target.managerId !== req.user!.id) {
        return res.status(403).json({ error: 'You can only manage your own team members' });
      }
    }

    const employee = await prisma.user.update({
      where: { id },
      data: {
        ...(firstName && { firstName }), ...(lastName && { lastName }),
        ...(phone !== undefined && { phone }), ...(email && { email }),
        ...(isActive !== undefined && { isActive }),
        ...(department !== undefined && { department }),
        ...(isSuper(req) && managerId !== undefined && { managerId: managerId || null }),
      },
      select: { id: true, username: true, email: true, firstName: true, lastName: true, phone: true, department: true, isActive: true },
    });
    res.json(employee);
  } catch {
    res.status(500).json({ error: 'Failed to update employee' });
  }
}

export async function resetEmployeePassword(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;

    if (!isSuper(req)) {
      const target = await prisma.user.findUnique({ where: { id }, select: { managerId: true, role: true } });
      if (!target || target.role !== 'EMPLOYEE' || target.managerId !== req.user!.id) {
        return res.status(403).json({ error: 'You can only manage your own team members' });
      }
    }

    const tempPassword = 'Reset@' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const hash = await bcrypt.hash(tempPassword, 12);
    await prisma.user.update({ where: { id }, data: { passwordHash: hash, mustChangePassword: true } });
    await prisma.activityLog.create({ data: { action: 'PASSWORD_RESET', description: `${req.user!.username} reset password for user ${id}`, userId: req.user!.id } });
    res.json({ tempPassword, message: 'Password reset. User must change on next login.' });
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
      prisma.task.findMany({ where: { ...taskFilter(req), createdAt: { gte: from } } }),
      prisma.user.findMany({ where: { ...teamFilter(req), isActive: true }, select: { id: true, firstName: true, lastName: true } }),
    ]);

    const totalCompleted = tasks.filter(t => t.status === 'COMPLETED').length;
    const totalOverdue = tasks.filter(t => t.status !== 'COMPLETED' && t.dueAt < now).length;
    const completionRate = tasks.length > 0 ? Math.round((totalCompleted / tasks.length) * 100) : 0;

    const days = period === 'daily' ? 1 : period === 'monthly' ? 30 : 7;
    const chart = Array.from({ length: days }, (_, i) => {
      const day = new Date(from); day.setDate(day.getDate() + i); day.setHours(0, 0, 0, 0);
      const next = new Date(day); next.setDate(next.getDate() + 1);
      const dayTasks = tasks.filter(t => t.createdAt >= day && t.createdAt < next);
      return {
        label: day.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        assigned: dayTasks.length,
        completed: dayTasks.filter(t => t.status === 'COMPLETED').length,
      };
    });

    const employeePerformance = employees.map((emp) => {
      const empTasks = tasks.filter(t => t.assignedToId === emp.id);
      return {
        ...emp,
        totalAssigned: empTasks.length,
        completed: empTasks.filter(t => t.status === 'COMPLETED').length,
        overdue: empTasks.filter(t => t.status !== 'COMPLETED' && t.dueAt < now).length,
      };
    });

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
      where: { ...taskFilter(req), createdAt: { gte: from } },
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

    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
}
