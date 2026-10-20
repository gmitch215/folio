import binaryen from 'binaryen';

export interface NativeAccess {
	parameter: number;
	offset: number;
	bytes: number;
	write: boolean;
}

export interface NativePlan {
	accesses: NativeAccess[];
	workParameters: number[];
}

type Info = ReturnType<typeof binaryen.getExpressionInfo> & Record<string, any>;
function info(expression: number): Info {
	const id = binaryen.getExpressionId(expression);
	if (id === binaryen.NopId) return { id, type: binaryen.none } as Info;
	return binaryen.getExpressionInfo(expression) as Info;
}

const unary = new Set([
	binaryen.ClzInt32,
	binaryen.CtzInt32,
	binaryen.PopcntInt32,
	binaryen.EqZInt32,
	binaryen.ExtendS8Int32,
	binaryen.ExtendS16Int32
]);
const binary = new Set([
	binaryen.AddInt32,
	binaryen.SubInt32,
	binaryen.MulInt32,
	binaryen.AndInt32,
	binaryen.OrInt32,
	binaryen.XorInt32,
	binaryen.ShlInt32,
	binaryen.ShrUInt32,
	binaryen.ShrSInt32,
	binaryen.RotLInt32,
	binaryen.RotRInt32,
	binaryen.EqInt32,
	binaryen.NeInt32,
	binaryen.LtSInt32,
	binaryen.LtUInt32,
	binaryen.LeSInt32,
	binaryen.LeUInt32,
	binaryen.GtSInt32,
	binaryen.GtUInt32,
	binaryen.GeSInt32,
	binaryen.GeUInt32
]);

export function nativePlan(
	module: binaryen.Module,
	fn: binaryen.FunctionRef
): NativePlan | undefined {
	try {
		const outer = binaryen.getFunctionInfo(fn);
		const parameters = binaryen.expandType(outer.params);
		const root = info(outer.body);
		if (root.id !== binaryen.BlockId || root.children.length !== 2) return;
		const loop = info(root.children[1]);
		if (loop.id !== binaryen.LoopId) return;
		const body = info(loop.body);
		if (body.id !== binaryen.BlockId || body.children.length < 2) return;
		let payload = info(body.children[0]);
		if (payload.id === binaryen.DropId) payload = info(payload.value);
		if (payload.id !== binaryen.CallId || payload.isReturn) return;
		for (const expression of body.children.slice(1, -1)) {
			const set = info(expression);
			if (set.id !== binaryen.LocalSetId || set.isTee) return;
			const add = info(set.value);
			if (add.id !== binaryen.BinaryId || add.op !== binaryen.AddInt32) return;
			const left = info(add.left),
				right = info(add.right);
			if (left.id !== binaryen.LocalGetId || left.index !== set.index) return;
			if (right.id !== binaryen.ConstId || right.type !== binaryen.i32) return;
		}
		const arguments_: number[] = [];
		for (const expression of payload.operands) {
			const argument = info(expression);
			if (argument.id !== binaryen.LocalGetId || argument.index >= parameters.length) return;
			arguments_.push(argument.index);
		}
		const calleeRef = module.getFunction(payload.target);
		if (!calleeRef) return;
		const callee = binaryen.getFunctionInfo(calleeRef);
		const calleeParameters = binaryen.expandType(callee.params);
		if (!callee.body || calleeParameters.length !== arguments_.length) return;
		if (![binaryen.none, binaryen.i32].includes(callee.results)) return;
		if ([...parameters, ...calleeParameters, ...callee.vars].some((t) => t !== binaryen.i32))
			return;
		const accesses: NativeAccess[] = [];
		const pointers = new Set<number>();
		const writes: { expression: number; index: number }[] = [];
		const countdowns = new Map<number, number>();
		function visit(expression: number): boolean {
			const value = info(expression);
			if (![binaryen.none, binaryen.i32].includes(value.type)) return false;
			switch (value.id) {
				case binaryen.BlockId: {
					const loops = value.children.filter(
						(e: number) => info(e).id === binaryen.LoopId
					);
					if (!loops.length) return value.children.every(visit);
					if (value.children.length !== 2 || loops[0] !== value.children[1]) return false;
					const guard = info(value.children[0]),
						inner = info(loops[0]);
					if (
						guard.id !== binaryen.BreakId ||
						guard.name !== value.name ||
						guard.value ||
						!guard.condition
					)
						return false;
					const zero = info(guard.condition);
					if (zero.id !== binaryen.UnaryId || zero.op !== binaryen.EqZInt32) return false;
					const counter = info(zero.value),
						innerBody = info(inner.body);
					if (counter.id !== binaryen.LocalGetId || countdowns.has(counter.index))
						return false;
					if (innerBody.id !== binaryen.BlockId || !innerBody.children.length)
						return false;
					const tail = info(innerBody.children.at(-1));
					if (
						tail.id !== binaryen.BreakId ||
						tail.name !== inner.name ||
						tail.value ||
						!tail.condition
					)
						return false;
					const decrement = info(tail.condition);
					if (
						decrement.id !== binaryen.LocalSetId ||
						!decrement.isTee ||
						decrement.index !== counter.index
					)
						return false;
					const add = info(decrement.value);
					if (add.id !== binaryen.BinaryId || add.op !== binaryen.AddInt32) return false;
					const left = info(add.left),
						right = info(add.right);
					if (left.id !== binaryen.LocalGetId || left.index !== counter.index)
						return false;
					if (right.id !== binaryen.ConstId || right.value !== -1) return false;
					countdowns.set(counter.index, tail.condition);
					writes.push({ expression: tail.condition, index: counter.index });
					return innerBody.children.slice(0, -1).every(visit);
				}
				case binaryen.IfId:
					return (
						visit(value.condition) &&
						visit(value.ifTrue) &&
						(!value.ifFalse || visit(value.ifFalse))
					);
				case binaryen.SelectId:
					return visit(value.condition) && visit(value.ifTrue) && visit(value.ifFalse);
				case binaryen.LocalGetId:
				case binaryen.ConstId:
				case binaryen.NopId:
					return true;
				case binaryen.LocalSetId:
					writes.push({ expression, index: value.index });
					return visit(value.value);
				case binaryen.UnaryId:
					return unary.has(value.op) && visit(value.value);
				case binaryen.BinaryId:
					return binary.has(value.op) && visit(value.left) && visit(value.right);
				case binaryen.DropId:
					return visit(value.value);
				case binaryen.LoadId:
				case binaryen.StoreId: {
					const ptr = info(value.ptr),
						write = value.id === binaryen.StoreId;
					if (
						value.isAtomic ||
						ptr.id !== binaryen.LocalGetId ||
						ptr.index >= calleeParameters.length
					)
						return false;
					if (
						![1, 2, 4].includes(value.bytes) ||
						!Number.isInteger(value.offset) ||
						value.offset < 0 ||
						value.offset > 0xffffffff
					)
						return false;
					if (write && (info(value.value).type !== binaryen.i32 || !visit(value.value)))
						return false;
					pointers.add(ptr.index);
					accesses.push({
						parameter: arguments_[ptr.index]!,
						offset: value.offset,
						bytes: value.bytes,
						write
					});
					return true;
				}
				default:
					return false;
			}
		}
		if (!visit(callee.body) || !accesses.length) return;
		if (
			writes.some(
				(write) =>
					pointers.has(write.index) ||
					(countdowns.has(write.index) &&
						countdowns.get(write.index) !== write.expression)
			)
		)
			return;
		return {
			accesses,
			workParameters: [...countdowns.keys()]
				.filter((index) => index < arguments_.length)
				.map((index) => arguments_[index]!)
		};
	} catch {
		return;
	}
}
