using Workerd = import "/workerd/workerd.capnp";

const w0 :Workerd.Worker = (
	modules = [(name = "index.js", esModule = "const spin = (n) => {\n  let x = 1;\n  for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;\n  return x;\n};\nexport default {\n  fetch(request) {\n    const n = Number(new URL(request.url).searchParams.get('n'));\n    return new Response(String(spin(n)));\n  },\n};\n")],
	compatibilityDate = "2025-01-01",
);

const w1 :Workerd.Worker = (
	modules = [(name = "index.js", esModule = "const spin = (n) => {\n  let x = 1;\n  for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;\n  return x;\n};\nexport default {\n  fetch(request) {\n    const n = Number(new URL(request.url).searchParams.get('n'));\n    return new Response(String(spin(n)));\n  },\n};\n")],
	compatibilityDate = "2025-01-01",
);

const w2 :Workerd.Worker = (
	modules = [(name = "index.js", esModule = "const spin = (n) => {\n  let x = 1;\n  for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;\n  return x;\n};\nexport default {\n  fetch(request) {\n    const n = Number(new URL(request.url).searchParams.get('n'));\n    return new Response(String(spin(n)));\n  },\n};\n")],
	compatibilityDate = "2025-01-01",
);

const w3 :Workerd.Worker = (
	modules = [(name = "index.js", esModule = "const spin = (n) => {\n  let x = 1;\n  for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;\n  return x;\n};\nexport default {\n  fetch(request) {\n    const n = Number(new URL(request.url).searchParams.get('n'));\n    return new Response(String(spin(n)));\n  },\n};\n")],
	compatibilityDate = "2025-01-01",
);

const config :Workerd.Config = (
	services = [
		(name = "w0", worker = .w0),
		(name = "w1", worker = .w1),
		(name = "w2", worker = .w2),
		(name = "w3", worker = .w3),
	],
	sockets = [
		(name = "s0", address = "127.0.0.1:51294", http = (), service = "w0"),
		(name = "s1", address = "127.0.0.1:51295", http = (), service = "w1"),
		(name = "s2", address = "127.0.0.1:51296", http = (), service = "w2"),
		(name = "s3", address = "127.0.0.1:51297", http = (), service = "w3"),
	],
);
