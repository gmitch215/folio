import { createTaskLinks } from '../../src/tasks.ts';
import { type ContextOptions, type Contexts, openContexts } from './php-contexts.ts';

// explicit parallel API, not automatic extraction. The owner context (index 0) runs the request and
// submits named functions with serialized arguments to private server contexts (index 1 and up).

export const prelude = `<?php
if (!function_exists('task_submit')) {
	$GLOBALS['__t_submit'] = vrzno_env('cfwTaskSubmit');
	$GLOBALS['__t_join'] = vrzno_env('cfwTaskJoin');
	$GLOBALS['__t_inline'] = [];
	$GLOBALS['__t_cost'] = ['encodeNs' => 0, 'decodeNs' => 0, 'tasks' => 0];
	function __cfw_task_exec($fn, $b64) {
		return base64_encode(serialize($fn(...unserialize(base64_decode($b64)))));
	}
	function task_submit(string $fn, array $args = []): string {
		$t = hrtime(true);
		$payload = base64_encode(serialize($args));
		$GLOBALS['__t_cost']['encodeNs'] += hrtime(true) - $t;
		$GLOBALS['__t_cost']['tasks']++;
		if ($GLOBALS['__t_submit'] === null || !empty($GLOBALS['__t_inline_mode'])) {
			$id = 'i' . count($GLOBALS['__t_inline']);
			$GLOBALS['__t_inline'][$id] = [$fn, $payload];
			return $id;
		}
		return ($GLOBALS['__t_submit'])(json_encode(['fn' => $fn, 'b64' => $payload]));
	}
	function task_join(string $id) {
		if ($id[0] === 'i') {
			[$fn, $payload] = $GLOBALS['__t_inline'][$id];
			unset($GLOBALS['__t_inline'][$id]);
			$b64 = __cfw_task_exec($fn, $payload);
			$t = hrtime(true);
			$value = unserialize(base64_decode($b64));
			$GLOBALS['__t_cost']['decodeNs'] += hrtime(true) - $t;
			return $value;
		}
		$reply = json_decode(($GLOBALS['__t_join'])($id), true);
		if (!$reply['ok']) throw new RuntimeException($reply['b64']);
		$t = hrtime(true);
		$value = unserialize(base64_decode($reply['b64']));
		$GLOBALS['__t_cost']['decodeNs'] += hrtime(true) - $t;
		return $value;
	}
	function w_lcg(int $seed): Closure {
		$x = $seed;
		return function () use (&$x) { $x = ($x * 1103515245 + 12345) & 0x7fffffff; return $x; };
	}
	function w_hash(int $seed, int $n): string {
		$h = (string) $seed;
		$block = str_repeat(chr(65 + $seed % 26), 4096);
		for ($i = 0; $i < $n; $i++) $h = hash('sha256', $h . $block . $i);
		return $h;
	}
	function w_doc(int $seed, int $words): string {
		$nx = w_lcg($seed);
		$t = '';
		for ($i = 0; $i < $words; $i++) $t .= 'word' . ($nx() % 1000) . ' ';
		return $t;
	}
	function w_preg(string $doc): array {
		preg_match_all('/word(\\\\d+)\\\\s/', $doc, $m);
		$r = preg_replace_callback('/word(\\\\d)(\\\\d*)/', fn($q) => $q[2] . $q[1], $doc);
		return [count($m[1]), md5($r)];
	}
	function w_ser(int $seed, int $rows): array {
		$nx = w_lcg($seed);
		$d = [];
		for ($i = 0; $i < $rows; $i++) $d[] = ['id' => $i, 'n' => $nx(), 's' => str_repeat('k', $i % 17), 't' => [$i, $i * 2]];
		$s = serialize($d);
		$u = unserialize($s);
		$j = json_encode($u);
		return [md5($s), md5($j), count(json_decode($j, true))];
	}
	function w_sort(int $seed, int $n): string {
		$nx = w_lcg($seed);
		$a = [];
		for ($i = 0; $i < $n; $i++) $a[] = $nx() % 100000;
		sort($a);
		usort($a, fn($x, $y) => $y <=> $x);
		return md5(implode(',', $a));
	}
	function w_gz(int $seed, int $kb): array {
		$nx = w_lcg($seed);
		$t = '';
		for ($i = 0; $i < $kb * 16; $i++) $t .= 'chunk' . ($nx() % 5000) . ',' . str_repeat('ab', $nx() % 20) . ';';
		$z = gzcompress($t, 6);
		return [strlen($t), strlen($z), md5($z), md5(gzuncompress($z))];
	}
}
`;

// loaded only into Drupal contexts, after each has rendered once so the theme system is live
export const drupalPrelude = `<?php
if (!function_exists('w_render')) {
	function w_build(int $seed, int $items): array {
		$nx = w_lcg($seed);
		return ['#theme' => 'item_list', '#items' => array_map(fn($j) => ['#markup' => '<b>item ' . $seed . '-' . $j . ' ' . ($nx() % 1000) . '</b>'], range(1, $items))];
	}
	function w_render(array $build): array {
		$html = (string) \\Drupal::service('renderer')->renderInIsolation($build);
		return [strlen($html), md5($html)];
	}
	w_render(w_build(0, 20));
}
`;

export interface Workload {
	kind?: 'plain' | 'drupal';
	name: string;
	/** PHP expression building the list of [function, args] jobs inside the request */
	jobs: string;
	note: string;
}

export const workloads: Workload[] = [
	{
		name: 'hash-batch',
		jobs: 'array_map(fn($i) => ["w_hash", [$i, __N__]], range(0, 7))',
		note: '8 independent sha256 chains, tiny arguments'
	},
	{
		name: 'hash-small',
		jobs: 'array_map(fn($i) => ["w_hash", [$i, __N__]], range(0, 7))',
		note: '8 independent sha256 chains, a few ms each (dispatch cost visible)'
	},
	{
		name: 'preg-docs',
		jobs: 'array_map(fn($i) => ["w_preg", [w_doc($i, __N__)]], range(0, 7))',
		note: '8 documents built by the request, each passed to a task (copy cost visible)'
	},
	{
		name: 'serialize-roundtrip',
		jobs: 'array_map(fn($i) => ["w_ser", [$i, __N__]], range(0, 7))',
		note: '8 serialize, unserialize and json round trips over generated rows'
	},
	{
		name: 'compress',
		jobs: 'array_map(fn($i) => ["w_gz", [$i, __N__]], range(0, 7))',
		note: '8 independent gzcompress and gzuncompress round trips (ext-zlib inside the context)'
	},
	{
		kind: 'drupal',
		name: 'drupal-render-arrays',
		jobs: 'array_map(fn($i) => ["w_render", [w_build($i, __N__)]], range(0, 7))',
		note: '8 item_list render arrays built by the request, each rendered through the Drupal renderer and Twig in a task'
	},
	{
		name: 'mixed',
		jobs: '[["w_hash",[1,__N__]],["w_preg",[w_doc(2,__M__)]],["w_ser",[3,__M__]],["w_sort",[4,__M__]],["w_hash",[5,__N__]],["w_preg",[w_doc(6,__M__)]],["w_ser",[7,__M__]],["w_sort",[8,__M__]]]',
		note: '8 heterogeneous independent operations of different duration'
	}
];

/** sizes picked so one job is about 100 ms on the rig; calibrated by php-intra.ts calibrate */
export const defaultSizes: Record<string, { n: number; m?: number }> = {
	'hash-batch': { n: 2500 },
	'hash-small': { n: 60 },
	'preg-docs': { n: 75000 },
	'serialize-roundtrip': { n: 20000 },
	compress: { n: 4000 },
	'drupal-render-arrays': { n: 2000 },
	mixed: { n: 2500, m: 24000 }
};

export function requestCode(
	workload: Workload,
	size: { n: number; m?: number },
	mode: 'plain' | 'api' | 'inline',
	count = 8
) {
	if (count !== 8 && !workload.jobs.includes('range(0, 7)'))
		throw new Error(`${workload.name} has a fixed job list`);
	const jobs = workload.jobs
		.replaceAll('range(0, 7)', `range(0, ${count - 1})`)
		.replaceAll('__N__', String(size.n))
		.replaceAll('__M__', String(size.m ?? size.n));
	const body =
		mode === 'plain'
			? '$out=[];foreach($jobs as $j){$out[]=($j[0])(...$j[1]);}'
			: `$GLOBALS['__t_inline_mode']=${mode === 'inline' ? 'true' : 'false'};$ids=[];foreach($jobs as $j){$ids[]=task_submit($j[0],$j[1]);}$out=[];foreach($ids as $id){$out[]=task_join($id);}`;
	return `<?php $jobs=${jobs};${body}echo md5(serialize($out));`;
}

export const costCode =
	'<?php echo json_encode($GLOBALS["__t_cost"]);$GLOBALS["__t_cost"]=["encodeNs"=>0,"decodeNs"=>0,"tasks"=>0];';

/** opens one owner and `servers` task contexts joined by message ports and a wake counter each */
export async function openTaskContexts(
	options: Omit<ContextOptions, 'count' | 'perContext'> & { servers: number }
): Promise<Contexts> {
	const links = createTaskLinks(options.servers);
	const contexts = await openContexts({
		...options,
		count: options.servers + 1,
		perContext: (index) =>
			index === 0
				? {
						data: { task: { links: links.owner } },
						transfer: links.owner.map((link) => link.port)
					}
				: {
						data: { task: { link: links.server[index - 1] } },
						transfer: [links.server[index - 1]!.port]
					}
	});
	await contexts.runAll(prelude);
	if (options.kind === 'drupal') {
		await contexts.render();
		await contexts.runAll(drupalPrelude);
	}
	return contexts;
}
