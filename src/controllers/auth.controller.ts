import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth.middleware';
import { officeToday } from './attendance.controller';
import { io } from '../index';
import { emitToUser } from '../services/socket.service';

const prisma = new PrismaClient();

function signToken(user: { id: string; role: string; username: string }) {
  return jwt.sign(
    { id: user.id, role: user.role, username: user.username },
    process.env.JWT_SECRET!,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' } as any
  );
}

export async function login(req: Request, res: Response) {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
    if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    await prisma.activityLog.create({
      data: { action: 'LOGIN', description: `${user.username} logged in`, userId: user.id },
    });

    // ── Attendance: record session (skip if one is already open today) ──
    try {
      const today = officeToday();
      const openSession = await prisma.attendanceSession.findFirst({ where: { userId: user.id, date: today, logoutAt: null } });
      if (!openSession) {
        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
        const device = (req.headers['user-agent'] as string)?.slice(0, 250) || null;
        const isFirstToday = !(await prisma.attendanceSession.findFirst({ where: { userId: user.id, date: today } }));
        await prisma.attendanceSession.create({ data: { userId: user.id, date: today, loginAt: new Date(), ip, device } });

        // Late-arrival alert on first login of the day
        if (isFirstToday) {
          const settings = await prisma.workSettings.findUnique({ where: { id: 1 } });
          const lateAfter = settings?.lateAfter || '09:45';
          const nowHM = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
          if (nowHM > lateAfter && user.role === 'EMPLOYEE') {
            const recipients = new Set<string>();
            if (user.managerId) recipients.add(user.managerId);
            (await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { id: true } })).forEach(u => recipients.add(u.id));
            for (const id of recipients) {
              const notif = await prisma.notification.create({
                data: { type: 'ATTENDANCE_LATE', title: 'Late Arrival', message: `${user.firstName} ${user.lastName} logged in late at ${nowHM}`, recipientId: id, senderId: user.id },
              });
              emitToUser(io, id, 'notification', notif);
            }
          }
        }
      }
    } catch (e) { console.error('attendance record failed', e); }

    const token = signToken({ id: user.id, role: user.role, username: user.username });
    return res.json({
      token,
      user: {
        id: user.id, username: user.username, email: user.email,
        firstName: user.firstName, lastName: user.lastName,
        role: user.role, avatar: user.avatar, mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Login failed' });
  }
}

export async function logout(req: AuthRequest, res: Response) {
  try {
    const today = officeToday();
    const now = new Date();
    // close open attendance session + open break
    await prisma.attendanceSession.updateMany({ where: { userId: req.user!.id, date: today, logoutAt: null }, data: { logoutAt: now } });
    await prisma.breakSession.updateMany({ where: { userId: req.user!.id, date: today, endAt: null }, data: { endAt: now } });
    await prisma.activityLog.create({ data: { action: 'LOGOUT', description: `${req.user!.username} logged out`, userId: req.user!.id } });
    return res.json({ message: 'Logged out' });
  } catch {
    return res.status(500).json({ error: 'Logout failed' });
  }
}

export async function changePassword(req: AuthRequest, res: Response) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.mustChangePassword) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash, mustChangePassword: false } });

    return res.json({ message: 'Password changed successfully' });
  } catch {
    return res.status(500).json({ error: 'Failed to change password' });
  }
}

export async function getMe(req: AuthRequest, res: Response) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, username: true, email: true, firstName: true, lastName: true, role: true, avatar: true, mustChangePassword: true, lastLogin: true, isActive: true },
    });
    return res.json(user);
  } catch {
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
}
