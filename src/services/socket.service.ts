import { Server, Socket } from 'socket.io';

const userSockets = new Map<string, string>(); // userId -> socketId

export function setupSocket(io: Server) {
  io.on('connection', (socket: Socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('register', (userId: string) => {
      userSockets.set(userId, socket.id);
      socket.join(`user:${userId}`);
      console.log(`User ${userId} registered with socket ${socket.id}`);
    });

    socket.on('disconnect', () => {
      for (const [uid, sid] of userSockets.entries()) {
        if (sid === socket.id) { userSockets.delete(uid); break; }
      }
    });
  });
}

export function emitToUser(io: Server, userId: string, event: string, data: any) {
  io.to(`user:${userId}`).emit(event, data);
}

export function emitToAll(io: Server, event: string, data: any) {
  io.emit(event, data);
}
