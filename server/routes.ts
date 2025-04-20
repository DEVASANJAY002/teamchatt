import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { setupAuth } from "./auth";
import { z } from "zod";
import { insertMessageSchema, insertConversationSchema, insertConversationMemberSchema } from "@shared/schema";
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

interface WebSocketClient extends WebSocket {
  userId?: number;
}

interface WebSocketMessage {
  type: string;
  payload: any;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Set up authentication routes
  setupAuth(app);

  // HTTP API endpoints
  app.get("/api/users", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      next(error);
    }
  });

  // Conversations
  app.get("/api/conversations", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const conversations = await storage.getUserConversations(req.user.id);
      res.json(conversations);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/conversations", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const validatedData = insertConversationSchema.parse({
        ...req.body,
        createdBy: req.user.id
      });
      
      const conversation = await storage.createConversation(validatedData);
      
      // Add creator as the first member and admin for group chats
      await storage.addConversationMember({
        conversationId: conversation.id,
        userId: req.user.id,
        isAdmin: conversation.isGroup,
        canMessage: true
      });
      
      // Add other members if provided
      if (req.body.members && Array.isArray(req.body.members)) {
        for (const memberId of req.body.members) {
          if (memberId !== req.user.id) {
            await storage.addConversationMember({
              conversationId: conversation.id,
              userId: memberId,
              isAdmin: false,
              canMessage: true
            });
          }
        }
      }
      
      const memberDetails = await storage.getConversationMembers(conversation.id);
      res.status(201).json({ conversation, members: memberDetails });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/conversations/direct", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ message: "userId is required" });
      }
      
      // Check if direct conversation already exists
      let conversationId = await storage.getDirectConversation(req.user.id, userId);
      
      if (!conversationId) {
        // Create a new direct conversation
        const conversation = await storage.createConversation({
          isGroup: false,
          createdBy: req.user.id
        });
        
        // Add both users to the conversation
        await storage.addConversationMember({
          conversationId: conversation.id,
          userId: req.user.id,
          isAdmin: false,
          canMessage: true
        });
        
        await storage.addConversationMember({
          conversationId: conversation.id,
          userId: userId,
          isAdmin: false,
          canMessage: true
        });
        
        conversationId = conversation.id;
      }
      
      const conversation = await storage.getConversation(conversationId);
      const members = await storage.getConversationMembers(conversationId);
      
      res.json({ conversation, members });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/conversations/:id", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      // Check if user is a member of this conversation
      const members = await storage.getConversationMembers(conversationId);
      const isMember = members.some(member => member.userId === req.user.id);
      
      if (!isMember) {
        return res.status(403).json({ message: "You are not a member of this conversation" });
      }
      
      res.json({ conversation, members });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/conversations/:id/members", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const conversationId = parseInt(req.params.id);
      const { userId, isAdmin, canMessage } = req.body;
      
      // Validate the conversation exists
      const conversation = await storage.getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      // Check if user has permissions
      const members = await storage.getConversationMembers(conversationId);
      const currentUserMembership = members.find(m => m.userId === req.user.id);
      
      if (!currentUserMembership || (!currentUserMembership.isAdmin && conversation.isGroup)) {
        return res.status(403).json({ message: "You don't have permission to add members" });
      }
      
      // Add the member
      const memberData = insertConversationMemberSchema.parse({
        conversationId,
        userId,
        isAdmin: isAdmin || false,
        canMessage: canMessage !== undefined ? canMessage : true
      });
      
      const member = await storage.addConversationMember(memberData);
      res.status(201).json(member);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/conversations/:conversationId/members/:userId", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const conversationId = parseInt(req.params.conversationId);
      const userId = parseInt(req.params.userId);
      
      // Validate the conversation exists
      const conversation = await storage.getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      // Check if user has permissions
      const members = await storage.getConversationMembers(conversationId);
      const currentUserMembership = members.find(m => m.userId === req.user.id);
      
      // Allow users to remove themselves or admins to remove others
      if (!currentUserMembership || 
          (userId !== req.user.id && (!currentUserMembership.isAdmin || conversation.createdBy === userId))) {
        return res.status(403).json({ message: "You don't have permission to remove this member" });
      }
      
      await storage.removeConversationMember(conversationId, userId);
      res.status(200).json({ message: "Member removed successfully" });
    } catch (error) {
      next(error);
    }
  });

  // Messages
  app.get("/api/conversations/:id/messages", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const conversationId = parseInt(req.params.id);
      
      // Check if user is a member of this conversation
      const members = await storage.getConversationMembers(conversationId);
      const isMember = members.some(member => member.userId === req.user.id);
      
      if (!isMember) {
        return res.status(403).json({ message: "You are not a member of this conversation" });
      }
      
      const messages = await storage.getConversationMessages(conversationId);
      res.json(messages);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/messages", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const validatedData = insertMessageSchema.parse({
        ...req.body,
        senderId: req.user.id
      });
      
      // Check if user is a member and can message
      const members = await storage.getConversationMembers(validatedData.conversationId);
      const membership = members.find(member => member.userId === req.user.id);
      
      if (!membership) {
        return res.status(403).json({ message: "You are not a member of this conversation" });
      }
      
      if (!membership.canMessage) {
        return res.status(403).json({ message: "You don't have permission to send messages" });
      }
      
      const message = await storage.createMessage(validatedData);
      res.status(201).json(message);
      
      console.log(`Message created by user ${req.user.id} for conversation ${validatedData.conversationId}. Now sending WebSocket notifications...`);
      
      // Send notification to all members via WebSocket
      for (const member of members) {
        console.log(`Processing member ${member.userId} for WebSocket notification`);
        
        // Send to both the sender and other members to ensure all clients update
        const client = clients.get(member.userId);
        if (client && client.readyState === WebSocket.OPEN) {
          console.log(`Sending WebSocket notification to user ${member.userId}`);
          
          const notification = {
            type: 'new_message',
            payload: message
          };
          
          try {
            client.send(JSON.stringify(notification));
            console.log(`Successfully sent WebSocket notification to user ${member.userId}`);
          } catch (error) {
            console.error(`Failed to send WebSocket notification to user ${member.userId}:`, error);
          }
        } else {
          console.log(`Cannot send WebSocket notification to user ${member.userId}: ${client ? 'Not in OPEN state' : 'No connection'}`);
        }
      }
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/messages/:id", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const messageId = parseInt(req.params.id);
      const message = await storage.getMessage(messageId);
      
      if (!message) {
        return res.status(404).json({ message: "Message not found" });
      }
      
      // Only the sender can delete their message
      if (message.senderId !== req.user.id) {
        return res.status(403).json({ message: "You don't have permission to delete this message" });
      }
      
      await storage.deleteMessage(messageId);
      res.status(200).json({ message: "Message deleted successfully" });
      
      // Notify conversation members about the deleted message
      const members = await storage.getConversationMembers(message.conversationId);
      for (const member of members) {
        if (member.userId !== req.user.id) { // Don't notify the sender
          const client = clients.get(member.userId);
          if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'message_deleted',
              payload: {
                messageId,
                conversationId: message.conversationId
              }
            }));
          }
        }
      }
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/messages/:id", async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      
      const messageId = parseInt(req.params.id);
      const { content } = req.body;
      
      if (!content) {
        return res.status(400).json({ message: "Content is required" });
      }
      
      const message = await storage.getMessage(messageId);
      
      if (!message) {
        return res.status(404).json({ message: "Message not found" });
      }
      
      // Only the sender can edit their message
      if (message.senderId !== req.user.id) {
        return res.status(403).json({ message: "You don't have permission to edit this message" });
      }
      
      // Cannot edit deleted messages
      if (message.isDeleted) {
        return res.status(400).json({ message: "Cannot edit a deleted message" });
      }
      
      const updatedMessage = await storage.editMessage(messageId, content);
      res.json(updatedMessage);
      
      // Notify conversation members about the edited message
      const members = await storage.getConversationMembers(message.conversationId);
      for (const member of members) {
        if (member.userId !== req.user.id) { // Don't notify the sender
          const client = clients.get(member.userId);
          if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'message_edited',
              payload: updatedMessage
            }));
          }
        }
      }
    } catch (error) {
      next(error);
    }
  });

  // WebSocket setup
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  
  console.log("WebSocket server initialized with path: /ws");

  const clients = new Map<number, WebSocketClient>();

  wss.on('connection', (ws: WebSocketClient) => {
    console.log("New WebSocket connection established");
    
    ws.on('message', async (message: string) => {
      try {
        const parsedMessage: WebSocketMessage = JSON.parse(message);
        console.log(`Received WebSocket message of type ${parsedMessage.type}`);
        
        // Handle ping messages for heartbeat
        if (parsedMessage.type === 'ping') {
          try {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          } catch (error) {
            console.error("Error sending pong response:", error);
          }
        }
        
        switch (parsedMessage.type) {
          case 'auth':
            // Authenticate the WebSocket connection
            if (parsedMessage.payload && parsedMessage.payload.userId) {
              const userId = parsedMessage.payload.userId;
              console.log(`Authenticating WebSocket connection for user ${userId}`);
              
              // Check if user exists
              const user = await storage.getUser(userId);
              if (!user) {
                console.error(`WebSocket authentication failed: User ${userId} not found`);
                break;
              }
              
              // Close any existing connection for this user
              const existingConnection = clients.get(userId);
              if (existingConnection) {
                console.log(`Closing existing WebSocket connection for user ${userId}`);
                if (existingConnection.readyState === WebSocket.OPEN) {
                  existingConnection.close();
                }
              }
              
              // Set up the new connection
              ws.userId = userId;
              clients.set(userId, ws);
              console.log(`WebSocket connection authenticated for user ${userId}`);
              
              // Send confirmation to the client
              try {
                ws.send(JSON.stringify({
                  type: 'auth_success',
                  payload: { userId }
                }));
                console.log(`Authentication success message sent to user ${userId}`);
              } catch (error) {
                console.error(`Failed to send auth success message to user ${userId}:`, error);
              }
              
              // Notify other clients about this user's online status
              try {
                broadcastToAll({
                  type: 'user_status',
                  payload: {
                    userId: ws.userId,
                    status: 'online'
                  }
                }, ws.userId);
                console.log(`Online status broadcast sent for user ${userId}`);
              } catch (error) {
                console.error(`Failed to broadcast online status for user ${userId}:`, error);
              }
            } else {
              console.error('WebSocket authentication failed: Missing userId in payload');
            }
            break;
            
          case 'message':
            // Handle new message
            if (!ws.userId) break;
            
            try {
              const msgData = {
                conversationId: parsedMessage.payload.conversationId,
                senderId: ws.userId,
                content: parsedMessage.payload.content,
                attachments: parsedMessage.payload.attachments
              };
              
              // Store message
              const newMessage = await storage.createMessage(msgData);
              
              // Get conversation members to broadcast the message
              const members = await storage.getConversationMembers(newMessage.conversationId);
              
              // Broadcast to all members of the conversation
              for (const member of members) {
                const client = clients.get(member.userId);
                if (client && client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({
                    type: 'new_message',
                    payload: newMessage
                  }));
                }
              }
            } catch (error) {
              console.error('Error handling message:', error);
            }
            break;
            
          case 'typing':
            if (!ws.userId) break;
            
            // Broadcast typing notification to conversation members
            const conversationId = parsedMessage.payload.conversationId;
            const isTyping = parsedMessage.payload.isTyping;
            
            const members = await storage.getConversationMembers(conversationId);
            
            for (const member of members) {
              if (member.userId !== ws.userId) {
                const client = clients.get(member.userId);
                if (client && client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({
                    type: 'typing',
                    payload: {
                      conversationId,
                      userId: ws.userId,
                      isTyping
                    }
                  }));
                }
              }
            }
            break;
            
          case 'status_change':
            if (!ws.userId) break;
            
            const status = parsedMessage.payload.status;
            await storage.updateUserAvailability(ws.userId, status);
            
            // Broadcast status change to all clients
            broadcastToAll({
              type: 'user_status',
              payload: {
                userId: ws.userId,
                status
              }
            }, ws.userId);
            break;
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    });

    ws.on('close', async (code, reason) => {
      console.log(`WebSocket connection closed with code ${code}, reason: ${reason || 'No reason provided'}`);
      
      if (ws.userId) {
        console.log(`User ${ws.userId} disconnected, setting status to offline`);
        
        // Update user status to offline
        try {
          await storage.updateUserAvailability(ws.userId, 'offline');
          console.log(`Successfully updated user ${ws.userId} availability to offline`);
        } catch (error) {
          console.error(`Failed to update availability for user ${ws.userId}:`, error);
        }
        
        // Remove client from map
        clients.delete(ws.userId);
        
        // Notify other clients about this user's offline status
        try {
          broadcastToAll({
            type: 'user_status',
            payload: {
              userId: ws.userId,
              status: 'offline'
            }
          }, ws.userId);
          console.log(`Successfully broadcast offline status for user ${ws.userId}`);
        } catch (error) {
          console.error(`Failed to broadcast offline status for user ${ws.userId}:`, error);
        }
      }
    });
  });

  // Helper function to broadcast to all connected clients except sender
  function broadcastToAll(message: any, excludeUserId?: number) {
    clients.forEach((client, userId) => {
      if (userId !== excludeUserId && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }

  return httpServer;
}
