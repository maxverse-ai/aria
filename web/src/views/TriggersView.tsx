import { useEffect, useMemo, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import {
  ArrowPathIcon,
  BoltIcon,
  CalendarDaysIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  StopCircleIcon,
} from "@heroicons/react/24/outline";
import { apiGet, apiPost } from "@/lib/api";
import type { TriggerDefinitionView, TriggerReadView } from "@/lib/types";

export function TriggersView({ profiles }: { profiles: string[] }) {
  const [data, setData] = useState<TriggerReadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const showToast = useToast();

  const load = () => apiGet<TriggerReadView>("/api/triggers")
    .then((value) => { setData(value); setError(null); })
    .catch((cause) => setError(String(cause.message ?? cause)));

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, []);

  const counts = useMemo(() => ({
    active: data?.definitions.filter((item) => item.state === "active").length ?? 0,
    paused: data?.definitions.filter((item) => item.state === "paused").length ?? 0,
    failed: data?.occurrences.filter((item) => item.state === "dead").length ?? 0,
  }), [data]);

  async function execute(command: string, input: Record<string, unknown>) {
    setBusy(`${command}:${String(input.definitionId ?? input.occurrenceId ?? "new")}`);
    try {
      await apiPost("/api/triggers/execute", { command, input });
      showToast({ body: `定时任务已${actionLabel(command)}` });
      await load();
    } catch (cause) {
      showToast({ body: String((cause as Error).message ?? cause), type: "error" });
      throw cause;
    } finally {
      setBusy(null);
    }
  }

  return (
    <VStack gap={6}>
      <HStack gap={4} hAlign="between" vAlign="start" wrap="wrap">
        <VStack gap={1}>
          <Text type="supporting" color="accent" weight="semibold">Trigger Platform</Text>
          <Heading level={1}>定时任务</Heading>
          <Text color="secondary">统一管理计划、执行历史和结果投递；任务与飞书渠道完全解耦。</Text>
        </VStack>
        <Button label="新建任务" variant="primary" icon={<Icon icon={PlusIcon} size="sm" />} onClick={() => setCreating(true)} />
      </HStack>

      <Grid columns={{ minWidth: 190, max: 4, repeat: "fit" }} gap={3}>
        <Metric label="任务总数" value={data?.definitions.length ?? "—"} icon={CalendarDaysIcon} />
        <Metric label="运行中" value={data ? counts.active : "—"} icon={BoltIcon} status="success" />
        <Metric label="已暂停" value={data ? counts.paused : "—"} icon={PauseIcon} status="neutral" />
        <Metric label="待处理失败" value={data ? counts.failed : "—"} icon={StopCircleIcon} status={counts.failed ? "warning" : "success"} />
      </Grid>

      <Card padding={0}>
        <Layout
          header={<LayoutHeader padding={4} hasDivider><HStack hAlign="between" vAlign="center"><VStack gap={0.5}><Heading level={2}>任务定义</Heading><Text type="supporting" color="secondary">每 5 秒刷新</Text></VStack><Button label="刷新" variant="ghost" size="sm" icon={<Icon icon={ArrowPathIcon} size="sm" />} onClick={() => void load()} /></HStack></LayoutHeader>}
          content={<LayoutContent padding={0}>{renderDefinitions(data, error, busy, execute, setCancelTarget, load)}</LayoutContent>}
        />
      </Card>

      <Card padding={0}>
        <Layout
          header={<LayoutHeader padding={4} hasDivider><Heading level={2}>最近执行</Heading></LayoutHeader>}
          content={<LayoutContent padding={0}>{data && data.occurrences.length > 0 ? (
            <List density="compact" hasDividers>
              {[...data.occurrences].reverse().slice(0, 20).map((run) => (
                <ListItem
                  key={run.id}
                  label={<HStack gap={2} vAlign="center"><Text weight="semibold">{run.definitionId}</Text><Badge variant={run.state === "succeeded" ? "success" : run.state === "dead" ? "warning" : "neutral"} label={run.state} /></HStack>}
                  description={`${new Date(run.scheduledFor).toLocaleString()} · attempt ${run.attempt}${run.failure ? ` · ${run.failure.code}` : ""}`}
                />
              ))}
            </List>
          ) : <EmptyState isCompact title="还没有执行记录" description="任务到期或手动运行后会出现在这里。" />}</LayoutContent>}
        />
      </Card>

      <CreateTriggerDialog profiles={profiles} isOpen={creating} onOpenChange={setCreating} onCreate={async (input) => { await execute("create", input); setCreating(false); }} />
      <AlertDialog isOpen={cancelTarget !== null} onOpenChange={(open) => !open && setCancelTarget(null)} title="取消这个任务？" description="取消后不会再产生新的执行记录，历史仍然保留。" cancelLabel="返回" actionLabel="确认取消" isActionLoading={busy === `cancel:${cancelTarget}`} onAction={() => { if (cancelTarget) void execute("cancel", { definitionId: cancelTarget }).then(() => setCancelTarget(null)); }} />
    </VStack>
  );
}

function renderDefinitions(
  data: TriggerReadView | null,
  error: string | null,
  busy: string | null,
  execute: (command: string, input: Record<string, unknown>) => Promise<void>,
  cancel: (id: string) => void,
  reload: () => Promise<void>,
) {
  if (error) return <EmptyState isCompact title="无法读取定时任务" description={error} actions={<Button label="重试" onClick={() => void reload()} />} />;
  if (!data) return <HStack hAlign="center" vAlign="center" gap={2} style={{ padding: 40 }}><Spinner size="sm" aria-label="正在加载定时任务" /><Text color="secondary">正在加载…</Text></HStack>;
  if (data.definitions.length === 0) return <EmptyState title="还没有定时任务" description="创建任务后，Supervisor 会根据持久化时间游标发现到期工作。" icon={<Icon icon={CalendarDaysIcon} size="lg" color="secondary" />} />;
  return <List density="spacious" hasDividers>{data.definitions.map((item) => (
    <ListItem
      key={item.id}
      label={<HStack gap={2} vAlign="center" wrap="wrap"><Text weight="semibold">{item.metadata.label ?? item.id}</Text><Badge variant={item.state === "active" ? "success" : "neutral"} label={item.state} /><Badge variant="neutral" label={item.profileId} /></HStack>}
      description={`${scheduleLabel(item)} · 下次：${item.nextFireAt ? new Date(item.nextFireAt).toLocaleString() : "无"}`}
      startContent={<StatusDot variant={item.state === "active" ? "success" : "neutral"} label={item.state} isPulsing={item.state === "active"} />}
      endContent={<HStack gap={1} vAlign="center"><Button label="立即运行" size="sm" variant="secondary" icon={<Icon icon={PlayIcon} size="sm" />} isLoading={busy === `run-now:${item.id}`} onClick={() => void execute("run-now", { definitionId: item.id })} />{item.state === "active" ? <Button label="暂停" size="sm" variant="ghost" isLoading={busy === `pause:${item.id}`} onClick={() => void execute("pause", { definitionId: item.id })} /> : item.state === "paused" ? <Button label="恢复" size="sm" variant="ghost" isLoading={busy === `resume:${item.id}`} onClick={() => void execute("resume", { definitionId: item.id })} /> : null}{item.state !== "canceled" ? <Button label="取消" size="sm" variant="ghost" onClick={() => cancel(item.id)} /> : null}</HStack>}
    />
  ))}</List>;
}

function CreateTriggerDialog({ profiles, isOpen, onOpenChange, onCreate }: { profiles: string[]; isOpen: boolean; onOpenChange: (open: boolean) => void; onCreate: (input: Record<string, unknown>) => Promise<void> }) {
  const [profile, setProfile] = useState(profiles[0] ?? "");
  const [label, setLabel] = useState("");
  const [at, setAt] = useState(() => new Date(Date.now() + 3_600_000).toISOString());
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  return <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={680} purpose="form"><Layout header={<DialogHeader title="新建定时任务" onOpenChange={onOpenChange} />} content={<LayoutContent padding={5}><VStack gap={4}><TextInput label="Profile" description={`可用：${profiles.join("、") || "无"}`} value={profile} onChange={setProfile} isRequired width="100%" /><TextInput label="任务名称" value={label} onChange={setLabel} isRequired width="100%" /><TextInput label="首次执行时间" description="ISO 8601，例如 2026-09-04T09:00:00+08:00" value={at} onChange={setAt} isRequired width="100%" /><TextInput label="时区" value={timeZone} onChange={setTimeZone} isRequired width="100%" /><TextArea label="交给 Agent 的任务" value={prompt} onChange={setPrompt} rows={5} isRequired width="100%" /><Card padding={3}><Text type="supporting" color="secondary">Web 控制台创建的任务只写入执行历史。需要把结果投递回某个会话时，请在对应 Channel 中使用 /remind，系统会建立私有会话锚点。</Text></Card><HStack hAlign="end" gap={2}><Button label="取消" variant="ghost" onClick={() => onOpenChange(false)} /><Button label="创建任务" variant="primary" isLoading={saving} isDisabled={!profile || !label || !prompt || !at} onClick={() => { setSaving(true); void onCreate({ profileId: profile, ownerRef: "web:local-console", label, schedule: { kind: "once", at: new Date(at).toISOString() }, timeZone, prompt }).finally(() => setSaving(false)); }} /></HStack></VStack></LayoutContent>} /></Dialog>;
}

function Metric({ label, value, icon, status }: { label: string; value: string | number; icon: typeof BoltIcon; status?: "success" | "warning" | "neutral" }) {
  return <Card padding={4}><VStack gap={3}><HStack hAlign="between" vAlign="center"><Text type="label" color="secondary">{label}</Text>{status ? <StatusDot variant={status} label={label} /> : <Icon icon={icon} size="sm" color="secondary" />}</HStack><Heading level={2}>{value}</Heading></VStack></Card>;
}
function scheduleLabel(item: TriggerDefinitionView) { return `${item.triggerSpec.schedule.kind} · ${item.triggerSpec.timeZone}`; }
function actionLabel(command: string) { return ({ create: "创建", pause: "暂停", resume: "恢复", cancel: "取消", "run-now": "触发", retry: "重试", ack: "确认" } as Record<string, string>)[command] ?? "更新"; }
