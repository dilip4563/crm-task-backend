import { Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { AuthRequest } from '../middleware/auth.middleware';
import { io } from '../index';
import { emitToUser } from '../services/socket.service';

const prisma = new PrismaClient();

const TZ = 'Asia/Kolkata';

/** Current date string YYYY-MM-DD in office timezone */
export function officeToday(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function officeTimeHM(d: Date): string {
  return d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

async function getSettings() {
  let s = await prisma.workSettings.findUnique({ where: { id: 1 } });
  if (!s) s = await prisma.workSettings.create({ data: { id: 1 } });
  return s;
}

/** Minutes between two dates, capped at now */
function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
}

/** End time to use for an open session: now if today, else that date's work end */
function sessionEnd(s: { loginAt: Date; logoutAt: Date | null; date: string }, workEnd: string): Date {
  if (s.logoutAt) return s.logoutAt;
  if (s.date === officeToday()) return new Date();
  // stale open session from a previous day — cap at workEnd of that date
  const capped = new Date(`${s.date}T${workEnd}:00+05:30`);
  return capped > s.loginAt ? capped : s.loginAt;
}

/** Compute one day's attendance for a user from raw sessions/breaks */
async function computeDay(userId: string, date: string, settings: Awaited<ReturnType<typeof getSettings>>) {
  const [sessions, breaks] = await Promise.all([
    prisma.attendanceSession.findMany({ where: { userId, date }, orderBy: { loginAt: 'asc' } }),
    prisma.breakSession.findMany({ where: { userId, date }, orderBy: { startAt: 'asc' } }),
  ]);

  const grossMinutes = sessions.reduce((sum, s) => sum + minutesBetween(s.loginAt, sessionEnd(s, settings.workEnd)), 0);
  const breakMinutes = breaks.reduce((sum, b) => sum + minutesBetween(b.startAt, b.endAt || (date === officeToday() ? new Date() : b.startAt)), 0);
  const workMinutes = Math.max(0, grossMinutes - breakMinutes);

  const firstLogin = sessions[0]?.loginAt || null;
  const lastLogout = sessions.length && sessions.every(s => s.logoutAt) ? sessions[sessions.length - 1].logoutAt : null;

  let status: string = 'ABSENT';
  if (firstLogin) {
    status = officeTimeHM(firstLogin) <= settings.lateAfter ? 'PRESENT' : 'LATE';
  }
  const isHalfDay = firstLogin && date !== officeToday() && workMinutes < settings.halfDayHours * 60;
  const overtimeMinutes = Math.max(0, workMinutes - settings.fullDayHours * 60);

  const onBreak = breaks.some(b => !b.endAt) && date === officeToday();
  const online = sessions.some(s => !s.logoutAt) && date === officeToday();

  return {
    date, firstLogin, lastLogout, workMinutes, breakMinutes, overtimeMinutes,
    status, isHalfDay: !!isHalfDay, online, onBreak,
    sessions: sessions.map(s => ({ id: s.id, loginAt: s.loginAt, logoutAt: s.logoutAt, ip: s.ip, device: s.device, manual: s.manual })),
  };
}

// ── Employee endpoints ───────────────────────────────────────────
export async function getMyToday(req: AuthRequest, res: Response) {
  try {
    const settings = await getSettings();
    const today = officeToday();
    const day = await computeDay(req.user!.id, today, settings);
    const remainingMinutes = Math.max(0, settings.fullDayHours * 60 - day.workMinutes);
    res.json({ ...day, remainingMinutes, settings: { workStart: settings.workStart, workEnd: settings.workEnd, lateAfter: settings.lateAfter, fullDayHours: settings.fullDayHours } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch attendance' }); }
}

export async function getMyHistory(req: AuthRequest, res: Response) {
  try {
    const { month } = req.query; // YYYY-MM
    const settings = await getSettings();
    const m = (month as string) || officeToday().slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const daysInMonth = new Date(y, mo, 0).getDate();
    const today = officeToday();

    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${m}-${String(d).padStart(2, '0')}`;
      if (date > today) break;
      days.push(await computeDay(req.user!.id, date, settings));
    }

    const workedDays = days.filter(d => d.status !== 'ABSENT');
    const summary = {
      present: days.filter(d => d.status === 'PRESENT').length,
      late: days.filter(d => d.status === 'LATE').length,
      absent: days.filter(d => d.status === 'ABSENT' && new Date(d.date + 'T00:00:00').getDay() !== 0).length,
      halfDays: days.filter(d => d.isHalfDay).length,
      totalWorkMinutes: workedDays.reduce((s, d) => s + d.workMinutes, 0),
      totalOvertimeMinutes: workedDays.reduce((s, d) => s + d.overtimeMinutes, 0),
      avgWorkMinutes: workedDays.length ? Math.round(workedDays.reduce((s, d) => s + d.workMinutes, 0) / workedDays.length) : 0,
    };
    res.json({ month: m, days, summary });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch history' }); }
}

export async function startBreak(req: AuthRequest, res: Response) {
  try {
    const today = officeToday();
    const open = await prisma.breakSession.findFirst({ where: { userId: req.user!.id, date: today, endAt: null } });
    if (open) return res.status(400).json({ error: 'Break already in progress' });
    const br = await prisma.breakSession.create({ data: { userId: req.user!.id, date: today, startAt: new Date() } });
    res.json(br);
  } catch { res.status(500).json({ error: 'Failed to start break' }); }
}

export async function endBreak(req: AuthRequest, res: Response) {
  try {
    const today = officeToday();
    const open = await prisma.breakSession.findFirst({ where: { userId: req.user!.id, date: today, endAt: null } });
    if (!open) return res.status(400).json({ error: 'No break in progress' });
    const br = await prisma.breakSession.update({ where: { id: open.id }, data: { endAt: new Date() } });
    res.json(br);
  } catch { res.status(500).json({ error: 'Failed to end break' }); }
}

// ── Corrections ──────────────────────────────────────────────────
export async function createCorrection(req: AuthRequest, res: Response) {
  try {
    const { date, type, requestedLoginAt, requestedLogoutAt, reason } = req.body;
    if (!date || !type || !reason) return res.status(400).json({ error: 'Missing required fields' });

    const correction = await prisma.attendanceCorrection.create({
      data: {
        userId: req.user!.id, date, type, reason,
        requestedLoginAt: requestedLoginAt ? new Date(requestedLoginAt) : null,
        requestedLogoutAt: requestedLogoutAt ? new Date(requestedLogoutAt) : null,
      },
    });

    // notify manager + super admins
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { firstName: true, lastName: true, managerId: true } });
    const recipients = new Set<string>();
    if (me?.managerId) recipients.add(me.managerId);
    (await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { id: true } })).forEach(u => recipients.add(u.id));
    for (const id of recipients) {
      const notif = await prisma.notification.create({
        data: { type: 'CORRECTION_REQUEST', title: 'Attendance Correction Request', message: `${me?.firstName} ${me?.lastName} requested a correction for ${date}`, recipientId: id, senderId: req.user!.id },
      });
      emitToUser(io, id, 'notification', notif);
    }
    res.status(201).json(correction);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to submit correction' }); }
}

export async function getMyCorrections(req: AuthRequest, res: Response) {
  try {
    const list = await prisma.attendanceCorrection.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 20 });
    res.json({ corrections: list });
  } catch { res.status(500).json({ error: 'Failed' }); }
}

export async function getPendingCorrections(req: AuthRequest, res: Response) {
  try {
    const isSuper = req.user!.role === 'SUPER_ADMIN';
    const where: Prisma.AttendanceCorrectionWhereInput = isSuper
      ? { status: 'PENDING' }
      : { status: 'PENDING', user: { managerId: req.user!.id } };
    const list = await prisma.attendanceCorrection.findMany({
      where, orderBy: { createdAt: 'asc' },
      include: { user: { select: { firstName: true, lastName: true, username: true, department: true } } },
    });
    res.json({ corrections: list });
  } catch { res.status(500).json({ error: 'Failed' }); }
}

export async function reviewCorrection(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'APPROVED' | 'REJECTED'
    if (!['APPROVED', 'REJECTED'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const corr = await prisma.attendanceCorrection.findUnique({ where: { id }, include: { user: { select: { managerId: true, firstName: true } } } });
    if (!corr || corr.status !== 'PENDING') return res.status(404).json({ error: 'Correction not found or already reviewed' });
    if (req.user!.role !== 'SUPER_ADMIN' && corr.user.managerId !== req.user!.id) {
      return res.status(403).json({ error: 'You can only review your own team' });
    }

    const updated = await prisma.attendanceCorrection.update({
      where: { id }, data: { status: action, reviewedById: req.user!.id, reviewedAt: new Date() },
    });

    if (action === 'APPROVED') {
      // apply the correction as a manual session
      if (corr.type === 'MISSED_LOGOUT') {
        const open = await prisma.attendanceSession.findFirst({ where: { userId: corr.userId, date: corr.date, logoutAt: null }, orderBy: { loginAt: 'desc' } });
        if (open && corr.requestedLogoutAt) {
          await prisma.attendanceSession.update({ where: { id: open.id }, data: { logoutAt: corr.requestedLogoutAt } });
        }
      } else if (corr.requestedLoginAt) {
        await prisma.attendanceSession.create({
          data: { userId: corr.userId, date: corr.date, loginAt: corr.requestedLoginAt, logoutAt: corr.requestedLogoutAt, manual: true, device: 'Manual correction' },
        });
      }
    }

    await prisma.activityLog.create({
      data: { action: `CORRECTION_${action}`, description: `${req.user!.username} ${action.toLowerCase()} correction for ${corr.date}`, userId: req.user!.id },
    });

    const notif = await prisma.notification.create({
      data: { type: 'CORRECTION_REVIEWED', title: `Correction ${action === 'APPROVED' ? 'Approved ✅' : 'Rejected ❌'}`, message: `Your attendance correction for ${corr.date} was ${action.toLowerCase()}`, recipientId: corr.userId, senderId: req.user!.id },
    });
    emitToUser(io, corr.userId, 'notification', notif);

    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to review correction' }); }
}

// ── Admin overview ───────────────────────────────────────────────
export async function getAdminOverview(req: AuthRequest, res: Response) {
  try {
    const settings = await getSettings();
    const today = officeToday();
    const isSuper = req.user!.role === 'SUPER_ADMIN';
    const teamWhere: Prisma.UserWhereInput = isSuper
      ? { role: { in: ['EMPLOYEE', 'ADMIN'] }, isActive: true }
      : { role: 'EMPLOYEE', managerId: req.user!.id, isActive: true };

    const team = await prisma.user.findMany({ where: teamWhere, select: { id: true, firstName: true, lastName: true, username: true, department: true, role: true } });

    const rows = await Promise.all(team.map(async (u) => {
      const day = await computeDay(u.id, today, settings);
      return { ...u, ...day };
    }));

    const summary = {
      totalEmployees: team.length,
      present: rows.filter(r => r.status === 'PRESENT').length,
      late: rows.filter(r => r.status === 'LATE').length,
      absent: rows.filter(r => r.status === 'ABSENT').length,
      online: rows.filter(r => r.online).length,
      onBreak: rows.filter(r => r.onBreak).length,
      avgWorkMinutes: rows.length ? Math.round(rows.reduce((s, r) => s + r.workMinutes, 0) / rows.length) : 0,
      overtime: rows.filter(r => r.overtimeMinutes > 0).length,
    };

    // 7-day trend
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const date = officeToday(d);
      const sessions = await prisma.attendanceSession.groupBy({ by: ['userId'], where: { date, userId: { in: team.map(t => t.id) } } });
      trend.push({
        date: new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }),
        present: sessions.length,
        absent: Math.max(0, team.length - sessions.length),
      });
    }

    res.json({ summary, employees: rows.sort((a, b) => b.workMinutes - a.workMinutes), trend });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch overview' }); }
}

export async function exportAttendance(req: AuthRequest, res: Response) {
  try {
    const settings = await getSettings();
    const { month } = req.query;
    const m = (month as string) || officeToday().slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const daysInMonth = new Date(y, mo, 0).getDate();
    const today = officeToday();
    const isSuper = req.user!.role === 'SUPER_ADMIN';

    const team = await prisma.user.findMany({
      where: isSuper ? { role: { in: ['EMPLOYEE', 'ADMIN'] } } : { role: 'EMPLOYEE', managerId: req.user!.id },
      select: { id: true, firstName: true, lastName: true, username: true, department: true },
    });

    const fmt = (min: number) => `${Math.floor(min / 60)}h ${min % 60}m`;
    let csv = 'Employee,User ID,Department,Date,Login,Logout,Break,Working Hours,Overtime,Status\n';
    for (const u of team) {
      for (let d = 1; d <= daysInMonth; d++) {
        const date = `${m}-${String(d).padStart(2, '0')}`;
        if (date > today) break;
        const day = await computeDay(u.id, date, settings);
        csv += [
          `"${u.firstName} ${u.lastName}"`, u.username, u.department || '',
          date,
          day.firstLogin ? new Date(day.firstLogin).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '',
          day.lastLogout ? new Date(day.lastLogout).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '',
          fmt(day.breakMinutes), fmt(day.workMinutes), fmt(day.overtimeMinutes),
          day.isHalfDay ? 'HALF_DAY' : day.status,
        ].join(',') + '\n';
      }
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${m}.csv"`);
    res.send(csv);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Export failed' }); }
}

// ── Settings (Super Admin) ───────────────────────────────────────
export async function getWorkSettings(_req: AuthRequest, res: Response) {
  res.json(await getSettings());
}

export async function updateWorkSettings(req: AuthRequest, res: Response) {
  try {
    const { workStart, lateAfter, workEnd, fullDayHours, halfDayHours } = req.body;
    const s = await prisma.workSettings.upsert({
      where: { id: 1 },
      create: { id: 1, workStart, lateAfter, workEnd, fullDayHours, halfDayHours },
      update: { ...(workStart && { workStart }), ...(lateAfter && { lateAfter }), ...(workEnd && { workEnd }), ...(fullDayHours && { fullDayHours: Number(fullDayHours) }), ...(halfDayHours && { halfDayHours: Number(halfDayHours) }) },
    });
    res.json(s);
  } catch { res.status(500).json({ error: 'Failed to update settings' }); }
}
