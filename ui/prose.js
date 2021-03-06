const pull = require('pull-stream')
const pullAbort = require('pull-abortable')

const Y = require('yjs')
const { ySyncPlugin, yUndoPlugin, undo, redo } = require('y-prosemirror')
const { EditorState } = require('prosemirror-state')
const { EditorView } = require('prosemirror-view')
const { schema, defaultMarkdownParser, defaultMarkdownSerializer } = require('prosemirror-markdown')
const { exampleSetup, buildMenuItems } = require('prosemirror-example-setup')
const { keymap } = require('prosemirror-keymap')

module.exports = function () {
  var abortablePullStream = null
  const ydoc = new Y.Doc()
  var connected = 0

  function uint8ArrayToStrBase64(a) {
    return btoa(String.fromCharCode.apply(null, a))
  }
  
  function strBase64ToUint8Array(s) {
    return Uint8Array.from([].map.call(atob(s), c => c.charCodeAt(0)))
  }

  function createProseMirrorView(content) {
    const type = ydoc.getXmlFragment('prosemirror')
    const editor = document.getElementById('editor')

    const mi = buildMenuItems(schema)

    return new EditorView(editor, {
      state: EditorState.create({
        doc: defaultMarkdownParser.parse(content),
        schema,
        plugins: [
          ySyncPlugin(type),
          yUndoPlugin(),
          keymap({
            'Mod-z': undo,
            'Mod-y': redo,
            'Mod-Shift-z': redo
          })
        ].concat(exampleSetup({
          schema,
          menuContent: [
            [mi.toggleStrong, mi.toggleEm],
            [mi.makeHead1, mi.makeHead2],
            [mi.wrapBulletList, mi.wrapOrderedList, mi.wrapBlockQuote]
          ]
        }))
      })
    })
  }

  function sendInitialState() {
    // FIXME: maybe save their state and only send them updates based on that
    const state = uint8ArrayToStrBase64(Y.encodeStateAsUpdate(ydoc))
    //console.log("sending initial state", state)
    SSB.net.tunnelMessage.sendMessage("prose-current-state", state)
  }
  
  function sendInitialStateOnConnect() {
    SSB.net.once('rpc:connect', function (rpc, isClient) {
      if (rpc.id == '@' + SSB.remoteAddress.split(':')[3]) {
        sendInitialStateOnConnect() // a tunnel is multiple connects
        return
      }

      sendInitialState()
    })
  }

  return {
    template: `
    <div id="prose">
      <div id='myId'>Your id: {{ SSB.net.id }}</div>
      <button class="clickButton" id="acceptConnections" v-on:click="acceptMessages">Host session</button>   or
      <input type="text" id="tunnelConnect" v-on:keyup.enter="connectDisconnect" v-model="remoteId" placeholder="remote feedId" /><button class="clickButton" v-on:click="connectDisconnect">{{ connectText }}</button>

      <h2>Shared document</h2>

      <div id="description">
        The state of the shared document is synchronized using
        off-chain messages sent encrypted between you and the
        other end through the magic of tunnels and CRDTs.
      </div>

      <div>
        <div id="editor"></div>
        <button class="clickButton" v-on:click="exportMarkdown">Export text as markdown to clipboard</button>
      </div>

      <br>

      <h2>Messages</h2>

      <div>
        <input type="text" id="chatMessage" v-model="chatText" v-on:keyup.enter="onChatSend" placeholder="type message, enter to send" />
        <div id="status"></div>
      </div>
    </div>`,

    data: function() {
      return {
        connectText: "Connect to host",
        remoteId: "",
        documentText: "",
        chatText: "",
        proseMirrorView: null
      }
    },

    methods: {
      acceptMessages: function() {
        SSB.net.tunnelMessage.acceptMessages((remoteId) => {
          sendInitialStateOnConnect()
	  return confirm("Allow connection from: " + remoteId + "?")
        })
      },

      connectDisconnect: function() {
        if (this.connectText == "Connect to host") {
          SSB.net.tunnelMessage.connect(this.remoteId, sendInitialState)
          this.connectText = "Disconnect from host"
        } else {
          SSB.net.tunnelMessage.disconnect()
          this.connectText = "Connect to host"
        }
      },

      onChatSend: function() {
        SSB.net.tunnelMessage.sendMessage("chat", this.chatText)
        this.chatText = ''
      },

      exportMarkdown: function() {
        const md = defaultMarkdownSerializer.serialize(this.proseMirrorView.state.doc)
        navigator.clipboard.writeText(md)
        alert("Exported markdown text to clipboard")
      }
    },

    created: function() {
      abortablePullStream = pullAbort()
      pull(
        SSB.net.tunnelMessage.messages(),
        abortablePullStream,
        pull.drain((msg) => {
          var user = msg.user
          if (msg.type == "chat")
            user = user.substr(0, 10)

          if (SSB.profiles[msg.user])
            user = SSB.profiles[msg.user].name
          else if (msg.user == SSB.net.id)
            user = "me"
          
          if (msg.type == 'info' && msg.data == "connected") {
            connected++
            document.getElementById("status").innerHTML += `${user} connected<br>`
          }
          else if (msg.type == 'info' && msg.data == "disconnected") {
            connected--
            document.getElementById("status").innerHTML += `${user} disconnected<br>`
            this.connectText = "Connect to host"
          }
          else if (msg.type == 'info' && msg.data == "waiting for accept") {
            document.getElementById("status").innerHTML += `waiting for ${user} to accept<br>`
          }
          else if (user != "me" && (msg.type == "prose-current-state" || msg.type == "prose-state-update"))
          {
            //console.log("got update msg", msg.data)
            Y.applyUpdate(ydoc, strBase64ToUint8Array(msg.data))
          }
          else if (user == "me" && (msg.type == "prose-current-state" || msg.type == "prose-state-update"))
          {
            // skip own state updates
          }
          else if (msg.type == 'chat') {
            document.getElementById("status").innerHTML += `${user}> ${msg.data}<br>`
          }
          else
            console.log("got unknown msg", msg)
        })
      )
    },

    mounted: function() {
      ydoc.on('update', update => {
        if (connected > 0) {
          const state = uint8ArrayToStrBase64(update)
          SSB.net.tunnelMessage.sendMessage("prose-state-update", state)
        }
      })

      this.proseMirrorView = createProseMirrorView("")
    },

    beforeRouteLeave: function(from, to, next) {
      if (abortablePullStream != null) {
        abortablePullStream.abort()
        abortablePullStream = null
      }
      next()
    }
  }
}
