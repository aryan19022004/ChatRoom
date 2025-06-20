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


//mongoose connect  --> connecting online mongodb
mongoose.connect("mongodb+srv://at7123029:19feb2004@cluster0.2m06u.mongodb.net/chatROOM", {
}).then(() => {
    console.log("MongoDB Connected");

    // ⬇ Change Stream ko MongoDB connect hone ke baad initialize karna hai
    const chatRoomChangeStream = ChatRoom.watch(); // Watch for changes in the collection

    chatRoomChangeStream.on("change", async (change) => {
        if (change.operationType === "delete") {
            const deletedRoomId = change.documentKey._id; // Get deleted room ID

            const deletedRoom = await ChatRoom.findById(deletedRoomId).lean(); // Find room by ID
            if (!deletedRoom) return; // Room not found, exit

            const deletedRoomName = deletedRoom.name; // Now we have the actual room name

            console.log(` Room deleted: ${deletedRoomName}`);

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


//Schema for chatroom database which has chatroom name and the users inside it 
const ChatRoomSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    users: { type: [String], default: [] },

    // 👇 Add this new field
    visibility: {
        type: String,
        enum: ['public', 'private'],
        default: 'public',
        required: true,
    },
});


//Model for the chatroom scchema
const ChatRoom = mongoose.model("ChatRoom", ChatRoomSchema);


app.set("view engine", "ejs"); // setting view engine as ejs
app.set('views', path.resolve('./views'))
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

//Get route for home page 
app.get("/", async (req, res) => {
    // AFTER: only grab public rooms that have users
    const publicRooms = await ChatRoom
        .find({ visibility: "public", users: { $ne: [] } })
        .distinct("name");
    res.render("index", { rooms: publicRooms });


});


//Get Route for chat room
app.get("/chat/:room", (req, res) => {
    const roomName = req.params.room;
    const username = req.query.username || null;

    // If we still need a username, show that prompt page:
    if (!username) {
        return res.render("usernamePrompt", { room: roomName });
    }

    // Otherwise just render the chat template—no DB reads or writes here:
    res.render("chat", { room: roomName, username });
});



// Handle file uploads
app.post("/upload", upload.single("file"), (req, res) => {
    if (req.file) {
        return res.json({ fileUrl: `/uploads/${req.file.filename}` });
    }
    res.status(400).json({ error: "File upload failed" });
});


// on connecting the WebSockets
io.on("connection", (socket) => {
    console.log("New user connected");

    //When new user join the chatroom
    socket.on("joinRoom", async ({ username, room, visibility = "public" }) => {
        try {
            console.log(`[JOIN] ${username} → ${room} (${visibility})`);

            let chatRoom = await ChatRoom.findOne({ name: room });

            if (!chatRoom) {
                // First time this room exists, and we now respect the chosen visibility:
                chatRoom = new ChatRoom({
                    name: room,
                    users: [username],
                    visibility
                });
            } else {
                if (chatRoom.users.includes(username)) {
                    socket.emit("usernameExists", "This username is already taken in this room.");
                    return;
                }
                chatRoom.users.push(username);
                // (No need to override visibility here; it was set on creation.)
            }

            await chatRoom.save();

            socket.join(room);
            socket.username = username;
            socket.room = room;

            io.to(room).emit("userJoined", `${username} joined the chat`);
            io.to(room).emit("updateUserList", chatRoom.users);

            // Broadcast only public rooms
            const publicRooms = await ChatRoom
                .find({ visibility: "public", users: { $ne: [] } })
                .distinct("name");
            io.emit("updateRooms", publicRooms);

        } catch (err) {
            console.error("Error in joinRoom:", err);
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
        console.log("File received:", fileType); // Debugging ke liye
        io.to(room).emit("message", { // Yeh line add ki
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
                //  Galti: Yeh pura list empty kar sakta hai
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

            //  Active rooms ka update sirf tab bhejo jab room exist kare
            const publicRooms = await ChatRoom
                .find({ visibility: "public", users: { $ne: [] } })
                .distinct("name");
            io.emit("updateRooms", publicRooms);

        }
    });

});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
