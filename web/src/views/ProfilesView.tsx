import { useEffect, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import {
  Layout,
  LayoutContent,
  LayoutHeader,
} from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import {
  ArrowPathIcon,
  ChevronRightIcon,
  CpuChipIcon,
  PlusIcon,
  SignalIcon,
  StopCircleIcon,
} from "@heroicons/react/24/outline";
import { apiGet, apiPost } from "@/lib/api";
import type { ProfileInfo, Status } from "@/lib/types";
import { OnboardWizard } from "./OnboardWizard";

export function ProfilesView({
  status,
  onOpen,
  onProfilesChanged,
}: {
  status: Status | null;
  onOpen: (profile: string) => void;
  onProfilesChanged: () => void;
}) {
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [stopTarget, setStopTarget] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const showToast = useToast();

  const load = () =>
    apiGet<{ profiles: ProfileInfo[] }>("/api/profiles")
      .then((data) => {
        setProfiles(data.profiles);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, []);

  async function start(name: string, e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(name);
    try {
      await apiPost("/api/profiles/start", { profile: name });
      showToast({ body: `已启动 ${name}` });
      await load();
    } catch (err) {
      showToast({ body: String((err as Error).message ?? err), type: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function confirmStop() {
    if (!stopTarget) return;
    setStopping(true);
    try {
      await apiPost("/api/profiles/stop", { profile: stopTarget });
      showToast({ body: `已停止 ${stopTarget}` });
      setStopTarget(null);
      setTimeout(() => void load(), 500);
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setStopping(false);
    }
  }

  const running = profiles?.filter((profile) => profile.running).length ?? 0;
  const stopped = profiles ? profiles.length - running : 0;

  return (
    <VStack gap={6}>
      <HStack gap={4} hAlign="between" vAlign="start" wrap="wrap">
        <VStack gap={1}>
          <Text type="supporting" color="accent" weight="semibold">运行总览</Text>
          <Heading level={1}>Profiles</Heading>
          <Text color="secondary">查看运行健康度、启动或停止本机 Agent 实例。</Text>
        </VStack>
        <Button
          label="新建 Profile"
          variant="primary"
          icon={<Icon icon={PlusIcon} size="sm" />}
          onClick={() => setCreating(true)}
        />
      </HStack>

      <Grid columns={{ minWidth: 190, max: 4, repeat: "fit" }} gap={3}>
        <MetricCard
          label="Profile 总数"
          value={profiles?.length ?? "—"}
          icon={CpuChipIcon}
          description="已注册的本地实例"
        />
        <MetricCard
          label="在线"
          value={profiles ? running : "—"}
          icon={SignalIcon}
          description="由 supervisor 托管"
          status="success"
        />
        <MetricCard
          label="未运行"
          value={profiles ? stopped : "—"}
          icon={StopCircleIcon}
          description="可随时重新启动"
          status={stopped > 0 ? "neutral" : "success"}
        />
        <MetricCard
          label="Supervisor"
          value={status?.hosted ? "Hosted" : "Local"}
          icon={ArrowPathIcon}
          description={status ? `Aria v${status.version}` : "正在读取版本"}
          status={status ? "success" : "warning"}
        />
      </Grid>

      <Card padding={0}>
        <Layout
          header={
            <LayoutHeader padding={4} hasDivider>
              <HStack hAlign="between" vAlign="center" gap={3}>
                <VStack gap={0.5}>
                  <Heading level={2}>实例状态</Heading>
                  <Text type="supporting" color="secondary">每 5 秒自动刷新</Text>
                </VStack>
                <Button
                  label="刷新"
                  variant="ghost"
                  size="sm"
                  icon={<Icon icon={ArrowPathIcon} size="sm" />}
                  onClick={() => void load()}
                />
              </HStack>
            </LayoutHeader>
          }
          content={
            <LayoutContent padding={0}>
              {error ? (
                <EmptyState
                  title="无法读取 Profiles"
                  description={error}
                  actions={<Button label="重试" onClick={() => void load()} />}
                  isCompact
                />
              ) : profiles === null ? (
                <HStack hAlign="center" vAlign="center" gap={2} style={{ padding: 40 }}>
                  <Spinner size="sm" aria-label="正在加载 profiles" />
                  <Text color="secondary">正在加载…</Text>
                </HStack>
              ) : profiles.length === 0 ? (
                <EmptyState
                  title="还没有 Profile"
                  description="创建一个飞书应用并连接 Claude Code 或 Codex。"
                  icon={<Icon icon={CpuChipIcon} size="lg" color="secondary" />}
                  actions={<Button label="新建 Profile" variant="primary" onClick={() => setCreating(true)} />}
                />
              ) : (
                <List density="spacious" hasDividers>
                  {profiles.map((profile) => (
                    <ListItem
                      key={profile.name}
                      label={
                        <HStack gap={2} vAlign="center" wrap="wrap">
                          <Text weight="semibold">{profile.name}</Text>
                          <Badge variant="neutral" label={profile.agentKind} />
                          <Badge
                            variant={profile.running ? "success" : "neutral"}
                            label={profile.running ? "在线" : "未运行"}
                          />
                        </HStack>
                      }
                      description={profile.running ? "进程已连接，配置修改可即时生效" : "当前没有运行中的 bot"}
                      startContent={
                        <StatusDot
                          variant={profile.running ? "success" : "neutral"}
                          label={profile.running ? "在线" : "未运行"}
                          isPulsing={profile.running}
                        />
                      }
                      endContent={
                        <HStack gap={2} vAlign="center">
                          {profile.running ? (
                            <Button
                              label="停止"
                              variant="ghost"
                              size="sm"
                              onClick={(event) => {
                                event.stopPropagation();
                                setStopTarget(profile.name);
                              }}
                            />
                          ) : (
                            <Button
                              label="启动"
                              variant="secondary"
                              size="sm"
                              isLoading={busy === profile.name}
                              isDisabled={busy === profile.name}
                              onClick={(event) => void start(profile.name, event)}
                            />
                          )}
                          <Icon icon={ChevronRightIcon} size="sm" color="secondary" />
                        </HStack>
                      }
                      onClick={() => onOpen(profile.name)}
                    />
                  ))}
                </List>
              )}
            </LayoutContent>
          }
        />
      </Card>

      <Dialog isOpen={creating} onOpenChange={setCreating} width={620} purpose="form">
        <Layout
          header={<DialogHeader title="新建 Profile" onOpenChange={setCreating} />}
          content={
            <LayoutContent padding={5}>
              <OnboardWizard
                onCreated={(name) => {
                  setCreating(false);
                  void load();
                  onProfilesChanged();
                  onOpen(name);
                }}
              />
            </LayoutContent>
          }
        />
      </Dialog>

      <AlertDialog
        isOpen={stopTarget !== null}
        onOpenChange={(open) => !open && setStopTarget(null)}
        title={`停止 ${stopTarget ?? "Profile"}？`}
        description="将停止该 profile 正在运行的 bot；若它是后台服务，也会禁用自动重启。之后可随时重新启动。"
        cancelLabel="取消"
        actionLabel="确认停止"
        isActionLoading={stopping}
        onAction={() => void confirmStop()}
      />
    </VStack>
  );
}

function MetricCard({
  label,
  value,
  icon,
  description,
  status,
}: {
  label: string;
  value: string | number;
  icon: typeof CpuChipIcon;
  description: string;
  status?: "success" | "warning" | "neutral";
}) {
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center">
          <Text type="label" color="secondary">{label}</Text>
          {status ? (
            <StatusDot variant={status} label={label} />
          ) : (
            <Icon icon={icon} size="sm" color="secondary" />
          )}
        </HStack>
        <Heading level={2}>{value}</Heading>
        <Text type="supporting" color="secondary">{description}</Text>
      </VStack>
    </Card>
  );
}
