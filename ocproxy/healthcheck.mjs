const res = await fetch(`http://127.0.0.1:${process.env.OC_PORT || process.env.PORT || 8788}/healthz`, {
  headers: { authorization: "Bearer " + process.env.OC_KEY },
})
process.exit(res.ok ? 0 : 1)
