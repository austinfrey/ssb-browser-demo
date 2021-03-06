// this is loaded from ui/browser.js when SSB is ready
const pull = require('pull-stream')

// this uses https://github.com/arj03/ssb-partial-replication
SSB.syncFeedAfterFollow = function(feedId) {
  SSB.connected((rpc) => {
    delete SSB.state.feeds[feedId]
    SSB.db.last.setPartialLogState(feedId, false)

    console.time("downloading messages")

    pull(
      rpc.partialReplication.getFeedReverse({ id: feedId, limit: 100, keys: false }),
      pull.asyncMap(SSB.db.validateAndAddStrictOrder),
      pull.collect((err) => {
        if (err) throw err

        console.timeEnd("downloading messages")
        SSB.state.queue = []
      })
    )
  })
}

SSB.syncFeedFromSequence = function(feedId, sequence, cb) {
  SSB.connected((rpc) => {
    var seqStart = sequence - 100
    if (seqStart < 0)
      seqStart = 0

    console.time("downloading messages")

    pull(
      rpc.partialReplication.getFeed({ id: feedId, seq: seqStart, keys: false }),
      pull.asyncMap(SSB.db.validateAndAdd),
      pull.collect((err, msgs) => {
        if (err) throw err

        console.timeEnd("downloading messages")
        SSB.state.queue = []

        if (cb)
          cb()
      })
    )
  })
}

SSB.syncFeedFromLatest = function(feedId, cb) {
  SSB.connected((rpc) => {
    console.time("downloading messages")

    pull(
      rpc.partialReplication.getFeedReverse({ id: feedId, keys: false, limit: 25 }),
      pull.asyncMap(SSB.db.validateAndAdd),
      pull.collect((err, msgs) => {
        if (err) throw err

        console.timeEnd("downloading messages")
        SSB.state.queue = []

        if (cb)
          cb()
      })
    )
  })
}

SSB.syncLatestProfile = function(feedId, profile, latestSeq, cb) {
  SSB.connected((rpc) => {
    if (latestSeq <= 0) return cb()

    var seqStart = latestSeq - 200
    if (seqStart < 0)
      seqStart = 0

    var state = SSB.validate.initial()

    pull(
      rpc.partialReplication.getFeed({ id: feedId, seq: seqStart, keys: false, limit: 200 }),
      pull.collect((err, msgs) => {
        if (err) throw err

        msgs.reverse()

        msgs = msgs.filter((msg) => msg && msg.content.type == "about" && msg.content.about == feedId)

        for (var i = 0; i < msgs.length; ++i)
        {
          // we use appendOOO here because we are looking at messages in reverse order
          state = SSB.validate.appendOOO(state, null, msgs[i])
          if (state.error) return cb(state.error)

          var content = msgs[i].content

          if (content.name && !profile.name)
            profile.name = content.name

          if (!profile.image)
          {
            if (content.image && typeof content.image.link === 'string')
              profile.image = content.image.link
            else if (typeof content.image === 'string')
              profile.image = content.image
          }

          if (content.description && !profile.description)
            profile.description = content.description
        }

        if (profile.name && profile.image)
          cb(null, profile)
        else
          SSB.syncLatestProfile(feedId, profile, latestSeq - 200, cb)
      })
    )
  })
}


syncThread = function(messages, cb) {
  pull(
    pull.values(messages),
    pull.filter((msg) => msg && msg.content.type == "post"),
    pull.asyncMap(SSB.db.validateAndAdd),
    pull.collect(cb)
  )
}

// this uses https://github.com/arj03/ssb-partial-replication
SSB.getThread = function(msgId, cb)
{
  SSB.connected((rpc) => {
    rpc.partialReplication.getTangle(msgId, (err, messages) => {
      if (err) return cb(err)

      syncThread(messages, cb)
    })
  })
}

SSB.getOOO = function(msgId, cb)
{
  SSB.connected((rpc) => {
    SSB.net.ooo.get(msgId, cb)
  })
}

SSB.initialSync = function(onboard)
{
  function writeOnboardProfiles(onboard)
  {
    let cleaned = {}
    for (var key in onboard) {
      cleaned[key] = {
        image: onboard[key].image,
        name: onboard[key].name,
        description: onboard[key].description
      }
    }

    // merge in user updates
    for (var author in SSB.profiles) {
      Object.assign(cleaned[author], SSB.profiles[author])
    }

    localStorage['profiles.json'] = JSON.stringify(cleaned)

    SSB.profiles = cleaned
  }

  SSB.isInitialSync = true // for ssb-ebt
  SSB.net.connect(SSB.remoteAddress, (err, rpc) => {
    if (err) throw(err)

    var d = new Date()
    var onemonthsago = d.setMonth(d.getMonth() - 1)

    var totalMessages = 0
    var totalFilteredMessages = 0
    var totalPrivateMessages = 0
    var totalFeeds = 0

    console.time("downloading messages")

    function getMessagesForUser(index)
    {
      if (index >= Object.keys(onboard).length) {
        console.log("feeds", totalFeeds)
        console.log("messages", totalMessages)
        console.log("filtered", totalFilteredMessages)
        console.timeEnd("downloading messages")

        SSB.isInitialSync = false
        writeOnboardProfiles(onboard)

        return
      }

      var user = Object.keys(onboard)[index]

      // FIXME: filter out in script
      if (onboard[user].latestMsg == null) {
        getMessagesForUser(index+1)
        return
      }

      if (onboard[user].latestMsg.timestamp < onemonthsago && user != SSB.net.id) {
        //console.log("skipping older posts for", onboard[user].name)
        getMessagesForUser(index+1)
        return
      }

      var seqStart = onboard[user].latestMsg.seq - 25
      if (seqStart < 0)
        seqStart = 0

      if (user == SSB.net.id) // always all
        seqStart = 0
      else
        SSB.db.last.setPartialLogState(user, true)

      ++totalFeeds

      //console.log(`Downloading messages for: ${onboard[user].name}, seq: ${seqStart}`)

      pull(
        rpc.partialReplication.getFeed({ id: user, seq: seqStart, keys: false }),
        pull.asyncMap((msg, cb) => {
          ++totalMessages
          SSB.db.validateAndAddStrictOrder(msg, (err, res) => {
            if (res)
              ++totalFilteredMessages

            cb(err, res)
          })
        }),
        pull.collect((err) => {
          if (err) throw err

          SSB.state.queue = []

          getMessagesForUser(index+1)
        })
      )
    }

    getMessagesForUser(0)
  })
}
