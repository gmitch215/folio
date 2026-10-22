using Workerd = import "/workerd/workerd.capnp";

const main :Workerd.Worker = (
	modules = [(name = "index.js", esModule = "const spin = (n) => {\n  let x = 1;\n  for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;\n  return x;\n};\nexport default {\n  fetch(request) {\n    const n = Number(new URL(request.url).searchParams.get('n'));\n    return new Response(String(spin(n)));\n  },\n};\n")],
	compatibilityDate = "2025-01-01",
);

const config :Workerd.Config = (
	services = [
		(name = "main", worker = .main),
	],
	sockets = [
		(name = "http", address = "127.0.0.1:64930", http = (), service = "main"),
	],
);
