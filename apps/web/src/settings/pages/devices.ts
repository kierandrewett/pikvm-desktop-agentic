import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface DeviceRow {
    readonly id: string;
    readonly name: string;
    readonly createdAt: number;
    readonly lastUsedAt: number;
}

export const devicesKey = ["devices"] as const;

/** The desktop apps signed in to this host. Plain requests: the host answers them itself, they are not part of the app API. */
export function useDevices(enabled: boolean) {
    return useQuery<readonly DeviceRow[]>({
        queryKey: devicesKey,
        enabled,
        queryFn: async ({ signal }) => {
            const response = await fetch("/app/api/v1/devices", { signal });
            if (!response.ok)
                throw new Error(`The host answered ${response.status}.`);
            return ((await response.json()) as { devices: DeviceRow[] })
                .devices;
        },
    });
}

export function useRevokeDevice() {
    const queryClient = useQueryClient();
    return useMutation<void, Error, string>({
        mutationFn: async (id) => {
            const response = await fetch(`/app/api/v1/devices/${id}`, {
                method: "DELETE",
            });
            if (!response.ok)
                throw new Error(`The host answered ${response.status}.`);
        },
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: devicesKey }),
    });
}

