import { useEffect, useMemo, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import {
  ArrowPathIcon,
  BoltIcon,
  CalendarDaysIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { apiGet, apiPost } from "@/lib/api";
import type { TriggerDefinitionView, TriggerReadView } from "@/lib/types";

interface DefinitionRow extends Record<string, unknown> {
  id: string;
  label: string;
  profile: string;
  schedule: string;
  nextRun: string;
  state: TriggerDefinitionView["state"];
  definition: TriggerDefinitionView;
}

interface ExecutionRow extends Record<string, unknown> {
  id: string;
  definition: string;
  scheduled: string;
  state: string;
  attempt: number;
  failure: string;
}

export function TriggersView({ profiles }: { profiles: string[] }) {
  const [data, setData] = useState<TriggerReadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const showToast = useToast();

  const load = () => apiGet<TriggerReadView>("/api/triggers")
    .then((value) => {
      setData(value);
      setError(null);
    })
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
      showToast({ body: `自动化任务已${actionLabel(command)}` });
      await load();
    } catch (cause) {
      showToast({ body: String((cause as Error).message ?? cause), type: "error" });
      throw cause;
    } finally {
      setBusy(null);
    }
  }

  const definitionRows = (data?.definitions ?? [])
    .filter((item) => stateFilter === "all" || item.state === stateFilter)
    .filter((item) => {
      const search = query.trim().toLocaleLowerCase();
      return !search
        || item.id.toLocaleLowerCase().includes(search)
        || item.profileId.toLocaleLowerCase().includes(search)
        || (item.metadata.label ?? "").toLocaleLowerCase().includes(search);
    })
    .map<DefinitionRow>((item) => ({
      id: item.id,
      label: item.metadata.label ?? item.id,
      profile: item.profileId,
      schedule: scheduleLabel(item),
      nextRun: item.nextFireAt ? new Date(item.nextFireAt).toLocaleString() : "暂无计划",
      state: item.state,
      definition: item,
    }));

  const executionRows = [...(data?.occurrences ?? [])]
    .reverse()
    .slice(0, 20)
    .map<ExecutionRow>((run) => ({
      id: run.id,
      definition: run.definitionId,
      scheduled: new Date(run.scheduledFor).toLocaleString(),
      state: run.state,
      attempt: run.attempt,
      failure: run.failure?.code ?? "—",
    }));

  const definitionColumns: TableColumn<DefinitionRow>[] = [
    {
      key: "label",
      header: "任务",
      width: proportional(2),
      renderCell: (row) => (
        <VStack gap={0.5}>
          <Text weight="semibold">{row.label}</Text>
          <Text type="supporting" color="secondary">{row.id}</Text>
        </VStack>
      ),
    },
    {
      key: "profile",
      header: "Agent",
      width: proportional(1),
      renderCell: (row) => <Badge variant="neutral" label={row.profile} />,
    },
    { key: "schedule", header: "计划", width: proportional(1) },
    { key: "nextRun", header: "下次运行", width: proportional(1) },
    {
      key: "state",
      header: "状态",
      width: pixel(110),
      renderCell: (row) => (
        <Badge
          variant={row.state === "active" ? "success" : row.state === "canceled" ? "red" : "neutral"}
          label={stateLabel(row.state)}
        />
      ),
    },
    {
      key: "actions",
      header: "操作",
      width: pixel(250),
      resizable: false,
      renderCell: (row) => (
        <HStack gap={1} vAlign="center" wrap="wrap">
          <Button
            label="立即运行"
            size="sm"
            variant="secondary"
            icon={<Icon icon={PlayIcon} size="sm" />}
            isLoading={busy === `run-now:${row.id}`}
            onClick={() => void execute("run-now", { definitionId: row.id })}
          />
          {row.state === "active" ? (
            <Button
              label="暂停"
              size="sm"
              variant="ghost"
              icon={<Icon icon={PauseIcon} size="sm" />}
              isLoading={busy === `pause:${row.id}`}
              onClick={() => void execute("pause", { definitionId: row.id })}
            />
          ) : row.state === "paused" ? (
            <Button
              label="恢复"
              size="sm"
              variant="ghost"
              isLoading={busy === `resume:${row.id}`}
              onClick={() => void execute("resume", { definitionId: row.id })}
            />
          ) : null}
          {row.state !== "canceled" ? (
            <Button label="取消" size="sm" variant="ghost" onClick={() => setCancelTarget(row.id)} />
          ) : null}
        </HStack>
      ),
    },
  ];

  const executionColumns: TableColumn<ExecutionRow>[] = [
    { key: "definition", header: "任务", width: proportional(2) },
    { key: "scheduled", header: "计划时间", width: proportional(1) },
    {
      key: "state",
      header: "状态",
      width: pixel(110),
      renderCell: (row) => (
        <StatusDot
          variant={row.state === "succeeded" ? "success" : row.state === "dead" ? "error" : "neutral"}
          label={row.state}
        />
      ),
    },
    { key: "attempt", header: "尝试", width: pixel(80), align: "end" },
    { key: "failure", header: "错误", width: proportional(1) },
  ];

  return (
    <>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={6}>
            <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
              <VStack gap={1}>
                <Text type="supporting" color="accent" weight="semibold">AUTOMATIONS</Text>
                <Heading level={1}>自动化任务</Heading>
                <Text color="secondary">集中安排一次性或周期任务，并查看每次执行的状态和结果。</Text>
              </VStack>
              <Button
                label="新建自动化"
                variant="primary"
                icon={<Icon icon={PlusIcon} size="sm" />}
                onClick={() => setCreating(true)}
              />
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={4}>
            <VStack gap={6}>
              <Section variant={counts.failed ? "muted" : "transparent"} padding={4} dividers={["bottom"]}>
                <HStack gap={5} hAlign="between" vAlign="center" wrap="wrap">
                  <HStack gap={4} vAlign="center">
                    <Icon icon={BoltIcon} size="lg" color={counts.failed ? "warning" : "accent"} />
                    <VStack gap={0.5}>
                      <Heading level={2}>
                        {counts.failed ? `${counts.failed} 次执行需要关注` : "自动化运行正常"}
                      </Heading>
                      <Text color="secondary">
                        {data ? `${counts.active} 个运行中，${counts.paused} 个已暂停。` : "正在同步任务状态…"}
                      </Text>
                    </VStack>
                  </HStack>
                  <Button
                    label="刷新状态"
                    variant="ghost"
                    size="sm"
                    icon={<Icon icon={ArrowPathIcon} size="sm" />}
                    onClick={() => void load()}
                  />
                </HStack>
              </Section>

              <Section variant="transparent" padding={0}>
                <VStack gap={4}>
                  <HStack gap={3} vAlign="center" wrap="wrap">
                    <StackItem size="fill">
                      <TextInput
                        label="搜索任务"
                        isLabelHidden
                        placeholder="搜索任务、Agent 或 ID"
                        value={query}
                        onChange={setQuery}
                        startIcon={MagnifyingGlassIcon}
                        width="100%"
                      />
                    </StackItem>
                    <Selector
                      label="状态"
                      isLabelHidden
                      value={stateFilter}
                      options={[
                        { value: "all", label: "全部状态" },
                        { value: "active", label: "运行中" },
                        { value: "paused", label: "已暂停" },
                        { value: "draft", label: "草稿" },
                        { value: "canceled", label: "已取消" },
                      ]}
                      onChange={setStateFilter}
                      width={160}
                    />
                  </HStack>
                  <HStack gap={3} hAlign="between" vAlign="center">
                    <Heading level={2}>任务</Heading>
                    <Text type="supporting" color="secondary">{definitionRows.length} 个结果</Text>
                  </HStack>
                  <Divider />

                  {error ? (
                    <EmptyState
                      title="无法读取自动化"
                      description={error}
                      actions={<Button label="重试" onClick={() => void load()} />}
                    />
                  ) : !data ? (
                    <HStack hAlign="center" vAlign="center" minHeight={180}>
                      <Spinner size="sm" aria-label="正在加载自动化" />
                    </HStack>
                  ) : definitionRows.length === 0 ? (
                    <EmptyState
                      title={data.definitions.length === 0 ? "还没有自动化" : "没有匹配的任务"}
                      description={data.definitions.length === 0
                        ? "创建任务后，Supervisor 会在指定时间唤醒 Agent。"
                        : "尝试调整搜索词或状态筛选。"}
                      icon={<Icon icon={CalendarDaysIcon} size="lg" color="secondary" />}
                      actions={data.definitions.length === 0
                        ? <Button label="新建自动化" variant="primary" onClick={() => setCreating(true)} />
                        : <Button label="清除筛选" onClick={() => { setQuery(""); setStateFilter("all"); }} />}
                    />
                  ) : (
                    <Table<DefinitionRow>
                      data={definitionRows}
                      columns={definitionColumns}
                      idKey="id"
                      density="balanced"
                      dividers="rows"
                      hasHover
                      textOverflow="wrap"
                    />
                  )}
                </VStack>
              </Section>

              <Section variant="transparent" padding={0}>
                <VStack gap={4}>
                  <HStack gap={3} hAlign="between" vAlign="center">
                    <Heading level={2}>最近执行</Heading>
                    <Text type="supporting" color="secondary">最近 20 次运行记录</Text>
                  </HStack>
                  <Divider />
                  {executionRows.length === 0 ? (
                    <EmptyState isCompact title="还没有执行记录" description="任务到期或手动运行后会显示在这里。" />
                  ) : (
                    <Table<ExecutionRow>
                      data={executionRows}
                      columns={executionColumns}
                      idKey="id"
                      density="compact"
                      dividers="rows"
                      hasHover
                    />
                  )}
                </VStack>
              </Section>
            </VStack>
          </LayoutContent>
        }
      />

      <CreateTriggerDialog
        profiles={profiles}
        isOpen={creating}
        onOpenChange={setCreating}
        onCreate={async (input) => {
          await execute("create", input);
          setCreating(false);
        }}
      />

      <AlertDialog
        isOpen={cancelTarget !== null}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        title="取消这个自动化？"
        description="取消后不再产生新的执行记录，已有历史会继续保留。"
        cancelLabel="返回"
        actionLabel="确认取消"
        isActionLoading={busy === `cancel:${cancelTarget}`}
        onAction={() => {
          if (cancelTarget) {
            void execute("cancel", { definitionId: cancelTarget })
              .then(() => setCancelTarget(null));
          }
        }}
      />
    </>
  );
}

function CreateTriggerDialog({
  profiles,
  isOpen,
  onOpenChange,
  onCreate,
}: {
  profiles: string[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [profile, setProfile] = useState(profiles[0] ?? "");
  const [label, setLabel] = useState("");
  const [at, setAt] = useState(() => new Date(Date.now() + 3_600_000).toISOString());
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={680} purpose="form">
      <Layout
        header={<DialogHeader title="新建自动化" onOpenChange={onOpenChange} />}
        content={
          <LayoutContent padding={5}>
            <VStack gap={4}>
              <Selector
                label="执行 Agent"
                value={profile}
                options={profiles.map((name) => ({ value: name, label: name }))}
                onChange={setProfile}
                width="100%"
              />
              <TextInput label="任务名称" value={label} onChange={setLabel} isRequired width="100%" />
              <TextInput
                label="首次执行时间"
                description="ISO 8601，例如 2026-09-04T09:00:00+08:00"
                value={at}
                onChange={setAt}
                isRequired
                width="100%"
              />
              <TextInput label="时区" value={timeZone} onChange={setTimeZone} isRequired width="100%" />
              <TextArea label="交给 Agent 的任务" value={prompt} onChange={setPrompt} rows={5} isRequired width="100%" />
              <Card variant="blue" padding={3}>
                <Text type="supporting" color="secondary">
                  Web 控制台只管理任务执行。需要把结果投递回会话时，请在对应渠道中使用 /remind。
                </Text>
              </Card>
              <HStack hAlign="end" gap={2}>
                <Button label="取消" variant="ghost" onClick={() => onOpenChange(false)} />
                <Button
                  label="创建自动化"
                  variant="primary"
                  isLoading={saving}
                  isDisabled={!profile || !label || !prompt || !at}
                  onClick={() => {
                    setSaving(true);
                    void onCreate({
                      profileId: profile,
                      ownerRef: "web:local-console",
                      label,
                      schedule: { kind: "once", at: new Date(at).toISOString() },
                      timeZone,
                      prompt,
                    }).finally(() => setSaving(false));
                  }}
                />
              </HStack>
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function scheduleLabel(item: TriggerDefinitionView) {
  return `${item.triggerSpec.schedule.kind} · ${item.triggerSpec.timeZone}`;
}

function stateLabel(state: TriggerDefinitionView["state"]) {
  return ({ active: "运行中", paused: "已暂停", draft: "草稿", canceled: "已取消" })[state];
}

function actionLabel(command: string) {
  return ({
    create: "创建",
    pause: "暂停",
    resume: "恢复",
    cancel: "取消",
    "run-now": "触发",
    retry: "重试",
    ack: "确认",
  } as Record<string, string>)[command] ?? "更新";
}
