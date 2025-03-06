const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set("view engine", "ejs");
app.use(express.static("public"));

// File upload configuration
const storage = multer.diskStorage({
    destination: "public/uploads/",
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

let chatRooms = {}; // Store active chatrooms

app.get("/", (req, res) => {
    res.render("index", { rooms: Object.keys(chatRooms) }); // Send all chatrooms to the homepage
});

app.get("/chat/:room", (req, res) => {
    const room = req.params.room;
    if (!chatRooms[room]) chatRooms[room] = new Set();
    res.render("chat", { room });
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

    socket.on("joinRoom", ({ username, room }) => {
        socket.join(room);
        socket.username = username;
        socket.room = room;
    
        if (!chatRooms[room]) chatRooms[room] = new Set();
        chatRooms[room].add(username);
    
        // Notify users in the room
        io.to(room).emit("userJoined", `${username} joined the chat`);
    
        // Send updated user list to all users in the room
        io.to(room).emit("updateUserList", Array.from(chatRooms[room]));
    
        // Send updated room list to all users
        io.emit("updateRooms", Object.keys(chatRooms));
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
    socket.on("disconnect", () => {
        const username = socket.username;
        const userRoom = socket.room;
    
        if (username && userRoom && chatRooms[userRoom]) {
            chatRooms[userRoom].delete(username);
    
            // Notify users about the user leaving
            io.to(userRoom).emit("userleft", `${username} left the chat`);
    
            // Send updated user list to all users in the room
            io.to(userRoom).emit("updateUserList", Array.from(chatRooms[userRoom]));
    
            // If the room is empty, delete it
            if (chatRooms[userRoom].size === 0) {
                delete chatRooms[userRoom];
            }
    
            io.emit("updateRooms", Object.keys(chatRooms));
        }
    });
    
    
    
    
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
