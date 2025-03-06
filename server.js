const express = require("express");
const http = require("http");
const mongoose = require("mongoose")
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);


//mongoose connect

mongoose.connect("mongodb+srv://at7123029:19feb2004@cluster0.2m06u.mongodb.net/chatROOM", {
}).then(() => {
    console.log("MongoDB Connected");

    // ⬇️ Change Stream ko MongoDB connect hone ke baad initialize karna hai
    const chatRoomChangeStream = ChatRoom.watch(); // Watch for changes in the collection

    chatRoomChangeStream.on("change", async (change) => {
        if (change.operationType === "delete") {
            const deletedRoomId = change.documentKey._id; // Get deleted room ID

            const deletedRoom = await ChatRoom.findById(deletedRoomId).lean(); // Find room by ID
            if (!deletedRoom) return; // Room not found, exit

            const deletedRoomName = deletedRoom.name; // Now we have the actual room name

            console.log(`⚠️ Room deleted: ${deletedRoomName}`);

            // Emit event to all users in that room
            io.to(deletedRoomName).emit("roomDeleted", "This chatroom has been deleted!");

            // Force users to leave
            io.sockets.adapter.rooms.get(deletedRoomName)?.forEach((socketId) => {
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.leave(deletedRoomName);
                    socket.emit("forceDisconnect", "Room has been deleted!");
                }
            });

            io.emit("updateRooms", await ChatRoom.find({ users: { $ne: [] } }).distinct("name"));
        }
    });

}).catch(err => console.log(err));




const ChatRoomSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },

    users: { type: [String], default: [] },
});


const ChatRoom = mongoose.model("ChatRoom", ChatRoomSchema);


app.set("view engine", "ejs");
app.use(express.static("public"));

// File upload configuration-+
const storage = multer.diskStorage({
    destination: "public/uploads/",
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

let chatRooms = {}; // Store active chatrooms

app.get("/", async (req, res) => {
    const activeRooms = await ChatRoom.find({ users: { $ne: [] } }).distinct("name"); // Fetch rooms that have users
    res.render("index", { rooms: activeRooms });
});


app.get("/chat/:room", async (req, res) => {
    const roomName = req.params.room;
    const username = req.query.username || ""; //  Get username from query

    let room = await ChatRoom.findOne({ name: roomName });

    if (!room) {
        room = new ChatRoom({ name: roomName, users: [] }); //  Ensure users array is empty
        await room.save();
    }

    res.render("chat", { room: roomName, username }); //  Send username to frontend
});





// Handle file uploads
app.post("/upload", upload.single("file"), (req, res) => {
    if (req.file) {
        return res.json({ fileUrl: `/uploads/${req.file.filename}` });
    }
    res.status(400).json({ error: "File upload failed" });
});




io.on("connection", (socket) => {
    console.log("New user connected");

    socket.on("joinRoom", async ({ username, room }) => {
        try {
            console.log(`\n[JOIN REQUEST] Username: ${username}, Room: ${room}`);

            let chatRoom = await ChatRoom.findOne({ name: room });

            if (!chatRoom) {
                console.log("Room does not exist. Creating new room...");
                chatRoom = new ChatRoom({ name: room, users: [] });
            } else {
                console.log("Existing users in room before adding:", chatRoom.users);

                if (chatRoom.users.includes(username)) {
                    console.log("🚨 Username already exists in this room! Rejecting...");
                    socket.emit("usernameExists", "This username is already taken in this room.");
                    return;
                }
            }

            // Adding username
            chatRoom.users.push(username);
            await chatRoom.save();

            console.log("✅ User added successfully. Updated users list:", chatRoom.users);

            socket.join(room);
            socket.username = username;
            socket.room = room;

            io.to(room).emit("userJoined", `${username} joined the chat`);
            io.to(room).emit("updateUserList", chatRoom.users);
            io.emit("updateRooms", await ChatRoom.find().distinct("name"));

        } catch (error) {
            console.error("❌ Error in joinRoom event:", error);
        }
    });





    socket.on("kickUser", async ({ room, userToKick }) => {
        let chatRoom = await ChatRoom.findOne({ name: room });

        if (chatRoom && chatRoom.admin === socket.username) { // Ensure only admin can kick
            if (chatRoom.users.includes(userToKick)) {
                chatRoom.users = chatRoom.users.filter(user => user !== userToKick);
                await chatRoom.save();

                // Notify the kicked user
                const kickedSocket = [...io.sockets.sockets.values()].find(s => s.username === userToKick);
                if (kickedSocket) {
                    kickedSocket.leave(room);
                    kickedSocket.emit("kicked", "You have been removed from the chatroom.");
                }

                // Notify the remaining users
                io.to(room).emit("updateUserList", { users: chatRoom.users, admin: chatRoom.admin });
            }
        }
    });




    socket.on("chatMessage", ({ room, username, message }) => {
        io.to(room).emit("message", {
            type: "text",
            username: username,
            text: message,
        });
    });

    socket.on("typing", (room) => {
        socket.to(room).emit("userTyping", socket.username);
    });

    socket.on("stopTyping", (room) => {
        socket.to(room).emit("userStoppedTyping", socket.username);
    });




    socket.on("fileMessage", ({ room, username, fileUrl, fileType }) => {
        io.to(room).emit("message", {
            type: "file",
            username: username,
            fileUrl: fileUrl,
            fileType: fileType,
        });
    });

    socket.on("voiceMessage", ({ room, username, audioUrl }) => {
        io.to(room).emit("message", {
            type: "audio",
            username: username,
            audioUrl: audioUrl,
        });
    });
    socket.on("disconnect", async () => {
        const username = socket.username;
        const userRoom = socket.room;
    
        if (username && userRoom) {
            let chatRoom = await ChatRoom.findOne({ name: userRoom });
    
            if (chatRoom) {
                // ❌ Galti: Yeh pura list empty kar sakta hai
                chatRoom.users = chatRoom.users.filter(user => user !== username);
    
                // Agar users bach gaye hain to update karo, warna room delete mat karo bina check kiye
                if (chatRoom.users.length > 0) {
                    await chatRoom.save(); // ✅ Room ko save karna zaroori hai taaki update ho
                    io.to(userRoom).emit("updateUserList", chatRoom.users);
                } else {
                    await ChatRoom.deleteOne({ name: userRoom }); // ✅ Sirf tab delete karo jab koi user na ho
                }
    
                io.to(userRoom).emit("userleft", `${username} left the chat`);
            }
    
            // ✅ Active rooms ka update sirf tab bhejo jab room exist kare
            const activeRooms = await ChatRoom.find({ users: { $ne: [] } }).distinct("name");
            io.emit("updateRooms", activeRooms);
        }
    });
    







});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
