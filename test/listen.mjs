/**
 * 测试服务器监听随机端口。Windows 的临时端口是顺序分配的,会落到 fetch 拒连的「坏端口」
 * (如 6665–6669,报 `bad port`);碰上就换一个。列表取自 WHATWG Fetch 的 port blocking。
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export async function listenSafe(server, host = '127.0.0.1') {
  for (;;) {
    await new Promise((resolve) => server.listen(0, host, resolve));
    if (!BAD_PORTS.has(server.address().port)) return server.address().port;
    await new Promise((resolve) => server.close(resolve));
  }
}
