import binaryenTyped from 'binaryen';

// the package typings omit the expression namespaces and the C entry points the translation passes use
export const binaryen: any = binaryenTyped;

export type Setter = (expression: number) => void;
export type Visit = (child: number, set: Setter) => void;

export const refused: Record<number, string> = {
	[binaryen.AtomicRMWId]: 'atomics',
	[binaryen.AtomicCmpxchgId]: 'atomics',
	[binaryen.AtomicWaitId]: 'atomics',
	[binaryen.AtomicNotifyId]: 'atomics',
	[binaryen.AtomicFenceId]: 'atomics',
	[binaryen.MemoryCopyId]: 'memory.copy',
	[binaryen.MemoryFillId]: 'memory.fill',
	[binaryen.MemoryInitId]: 'memory.init',
	[binaryen.SIMDLoadId]: 'simd memory access',
	[binaryen.SIMDLoadStoreLaneId]: 'simd memory access',
	[binaryen.TryId]: 'exception handling'
};
const leaves = new Set<number>([
	binaryen.ConstId,
	binaryen.LocalGetId,
	binaryen.GlobalGetId,
	binaryen.MemorySizeId,
	binaryen.NopId,
	binaryen.UnreachableId,
	binaryen.RefFuncId,
	binaryen.DataDropId
]);

// every expression kind the walk knows; anything else is recorded and refused
export function children(e: number, id: number, visit: Visit, unknown: Set<string>) {
	switch (id) {
		case binaryen.BlockId:
			for (let k = 0, n = binaryen.Block.getNumChildren(e); k < n; k++)
				visit(binaryen.Block.getChildAt(e, k), (x) => binaryen.Block.setChildAt(e, k, x));
			return;
		case binaryen.IfId:
			visit(binaryen.If.getCondition(e), (x) => binaryen.If.setCondition(e, x));
			visit(binaryen.If.getIfTrue(e), (x) => binaryen.If.setIfTrue(e, x));
			if (binaryen.If.getIfFalse(e))
				visit(binaryen.If.getIfFalse(e), (x) => binaryen.If.setIfFalse(e, x));
			return;
		case binaryen.LoopId:
			visit(binaryen.Loop.getBody(e), (x) => binaryen.Loop.setBody(e, x));
			return;
		// the value of a branch runs before its condition
		case binaryen.BreakId:
			if (binaryen.Break.getValue(e))
				visit(binaryen.Break.getValue(e), (x) => binaryen.Break.setValue(e, x));
			if (binaryen.Break.getCondition(e))
				visit(binaryen.Break.getCondition(e), (x) => binaryen.Break.setCondition(e, x));
			return;
		case binaryen.SwitchId:
			if (binaryen.Switch.getValue(e))
				visit(binaryen.Switch.getValue(e), (x) => binaryen.Switch.setValue(e, x));
			visit(binaryen.Switch.getCondition(e), (x) => binaryen.Switch.setCondition(e, x));
			return;
		case binaryen.CallId:
			for (let k = 0, n = binaryen.Call.getNumOperands(e); k < n; k++)
				visit(binaryen.Call.getOperandAt(e, k), (x) => binaryen.Call.setOperandAt(e, k, x));
			return;
		case binaryen.CallIndirectId:
			for (let k = 0, n = binaryen.CallIndirect.getNumOperands(e); k < n; k++)
				visit(binaryen.CallIndirect.getOperandAt(e, k), (x) =>
					binaryen.CallIndirect.setOperandAt(e, k, x)
				);
			visit(binaryen.CallIndirect.getTarget(e), (x) => binaryen.CallIndirect.setTarget(e, x));
			return;
		case binaryen.LocalSetId:
			visit(binaryen.LocalSet.getValue(e), (x) => binaryen.LocalSet.setValue(e, x));
			return;
		case binaryen.GlobalSetId:
			visit(binaryen.GlobalSet.getValue(e), (x) => binaryen.GlobalSet.setValue(e, x));
			return;
		case binaryen.LoadId:
			visit(binaryen.Load.getPtr(e), (x) => binaryen.Load.setPtr(e, x));
			return;
		case binaryen.StoreId:
			visit(binaryen.Store.getPtr(e), (x) => binaryen.Store.setPtr(e, x));
			visit(binaryen.Store.getValue(e), (x) => binaryen.Store.setValue(e, x));
			return;
		case binaryen.UnaryId:
			visit(binaryen.Unary.getValue(e), (x) => binaryen.Unary.setValue(e, x));
			return;
		case binaryen.BinaryId:
			visit(binaryen.Binary.getLeft(e), (x) => binaryen.Binary.setLeft(e, x));
			visit(binaryen.Binary.getRight(e), (x) => binaryen.Binary.setRight(e, x));
			return;
		case binaryen.SelectId:
			visit(binaryen.Select.getIfTrue(e), (x) => binaryen.Select.setIfTrue(e, x));
			visit(binaryen.Select.getIfFalse(e), (x) => binaryen.Select.setIfFalse(e, x));
			visit(binaryen.Select.getCondition(e), (x) => binaryen.Select.setCondition(e, x));
			return;
		case binaryen.DropId:
			visit(binaryen.Drop.getValue(e), (x) => binaryen.Drop.setValue(e, x));
			return;
		case binaryen.ReturnId:
			if (binaryen.Return.getValue(e))
				visit(binaryen.Return.getValue(e), (x) => binaryen.Return.setValue(e, x));
			return;
		case binaryen.MemoryGrowId:
			visit(binaryen.MemoryGrow.getDelta(e), (x) => binaryen.MemoryGrow.setDelta(e, x));
			return;
		default:
			if (leaves.has(id)) return;
			unknown.add(refused[id] ?? `expression kind ${id}`);
	}
}
