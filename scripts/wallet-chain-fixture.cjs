async function mockWalletChain(context, lookup = () => ({ history: [], utxos: [] })) {
  const sockets = new Set();
  await context.routeWebSocket('**/ws/wallet', socket => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage(raw => {
      const query = JSON.parse(raw);
      socket.send(JSON.stringify({
        type: 'snapshot', id: query.id, tip: '00'.repeat(80), height: 100, source: 'fixture', ...(query.verify && { verified: true }),
        addresses: query.addresses.map(address => ({ address, ...lookup(address, query.network) })),
      }));
    });
  });
  return () => { for (const socket of sockets) socket.send(JSON.stringify({ type: 'changed' })); };
}

module.exports = { mockWalletChain };
