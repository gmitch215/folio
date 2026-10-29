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

const front :Workerd.Worker = (
	modules = [(name = "index.js", esModule = "let next = 0;\nexport default {\n  fetch(request, env) {\n    const targets = [env.W0, env.W1, env.W2, env.W3];\n    return targets[next++ % targets.length].fetch(request);\n  },\n};\n")],
	compatibilityDate = "2025-01-01",
	bindings = [(name = "W0", service = "w0"), (name = "W1", service = "w1"), (name = "W2", service = "w2"), (name = "W3", service = "w3")],
);

const config :Workerd.Config = (
	services = [
		(name = "w0", worker = .w0),
		(name = "w1", worker = .w1),
		(name = "w2", worker = .w2),
		(name = "w3", worker = .w3),
		(name = "front", worker = .front),
	],
	sockets = [
		(name = "http", address = "127.0.0.1:51293", http = (), service = "front"),
	],
);
