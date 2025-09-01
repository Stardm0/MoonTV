import { IKVDatabase } from "@/lib/types";

export class MemoryKVDatabase implements IKVDatabase
{
	obj = Object.create(null) as Record<string, string>;
	set(key: string, value: string | null): Promise<void>
	{
		if (value == null)
			delete this.obj[key];
		else
			this.obj[key] = value;
		return Promise.resolve();
	}
	get(key: string): Promise<string | null>
	{
		return Promise.resolve(this.obj[key] || null);
	}
	list(prefixKey: string): Promise<Array<[key: string, value: string]>>
	{
		const arr: Array<[string, string]> = [];
		for (const [k, v] of Object.entries(this.obj))
		{
			if (k.startsWith(prefixKey))
				arr.push([k, v]);
		}
		return Promise.resolve(arr);
	}
}