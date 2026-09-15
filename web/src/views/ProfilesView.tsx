import { useEffect, useMemo, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { useToast } from "@astryxdesign/core/Toast";
import {
  ArrowPathIcon,
  ArrowRightIcon,
  BoltIcon,
  CommandLineIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { apiGet, apiPost } from "@/lib/api";
import type { ProfileInfo, Status } from "@/lib/types";
import { OnboardWizard } from "./OnboardWizard";

type ProfileFilter = "all" | "running" | "stopped";

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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProfileFilter>("all");
  const showToast = useToast();

  const load = () =>
    apiGet<{ profiles: ProfileInfo[] }>("/api/profiles")
      .then((data) => {
        setProfiles(data.profiles);
        setError(null);
      })
      .catch((cause) => setError(String(cause.message ?? cause)));

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, []);

  const visibleProfiles = useMemo(() => {
    if (!profiles) return [];
    const search = query.trim().toLocaleLowerCase();
    return profiles.filter((profile) => {
      if (filter === "running" && !profile.running) return false;
      if (filter === "stopped" && profile.running) return false;
      return !search
        || profile.name.toLocaleLowerCase().includes(search)
        || profile.agentKind.toLocaleLowerCase().includes(search);
    });
  }, [filter, profiles, query]);

  async function start(name: string) {
    setBusy(name);
    try {
      await apiPost("/api/profiles/start", { profile: name });
      showToast({ body: `${name} 已启动` });
      await load();
    } catch (cause) {
      showToast({ body: String((cause as Error).message ?? cause), type: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function confirmStop() {
    if (!stopTarget) return;
    setStopping(true);
    try {
      await apiPost("/api/profiles/stop", { profile: stopTarget });
      showToast({ body: `${stopTarget} 已停止` });
      setStopTarget(null);
      setTimeout(() => void load(), 500);
    } catch (cause) {
      showToast({ body: String((cause as Error).message ?? cause), type: "error" });
    } finally {
      setStopping(false);
    }
  }

  const running = profiles?.filter((profile) => profile.running).length ?? 0;

  return (
    <>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={6}>
            <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
              <VStack gap={1}>
                <Text type="supporting" color="accent" weight="semibold">WORKSPACE</Text>
                <Heading level={1}>Agent 工作台</Heading>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <StatusDot
                    variant={status ? "success" : "warning"}
                    label={status ? "Supervisor 在线" : "正在连接 Supervisor"}
                    isPulsing={Boolean(status)}
                  />
                  <Text color="secondary">
                    {status ? `${running} 个在线，${profiles?.length ?? 0} 个已配置` : "状态会自动刷新"}
                  </Text>
                </HStack>
              </VStack>
              <Button
                label="添加 Agent"
                variant="primary"
                icon={<Icon icon={PlusIcon} size="sm" />}
                onClick={() => setCreating(true)}
              />
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={6}>
            <VStack gap={6}>
              <HStack gap={3} vAlign="center" wrap="wrap">
                <StackItem size="fill">
                  <TextInput
                    label="搜索 Agent"
                    isLabelHidden
                    placeholder="搜索名称或执行引擎"
                    value={query}
                    onChange={setQuery}
                    startIcon={MagnifyingGlassIcon}
                    width="100%"
                  />
                </StackItem>
                <ToggleButtonGroup
                  label="按运行状态筛选"
                  value={filter}
                  onChange={(value) => setFilter((value ?? "all") as ProfileFilter)}
                >
                  <ToggleButton label="全部" value="all" />
                  <ToggleButton label="在线" value="running" />
                  <ToggleButton label="未运行" value="stopped" />
                </ToggleButtonGroup>
                <Button
                  label="刷新"
                  variant="ghost"
                  icon={<Icon icon={ArrowPathIcon} size="sm" />}
                  onClick={() => void load()}
                />
              </HStack>

              <Section variant="transparent" padding={0}>
                <VStack gap={4}>
                  <HStack gap={3} hAlign="between" vAlign="center">
                    <Heading level={2}>所有 Agent</Heading>
                    <Text type="supporting" color="secondary">{visibleProfiles.length} 个结果</Text>
                  </HStack>
                  <Divider />

                  {error ? (
                    <EmptyState
                      title="无法读取 Agent"
                      description={error}
                      actions={<Button label="重试" onClick={() => void load()} />}
                    />
                  ) : profiles === null ? (
                    <HStack hAlign="center" vAlign="center" gap={2} minHeight={180}>
                      <Spinner size="sm" aria-label="正在加载 Agent" />
                      <Text color="secondary">正在加载 Agent…</Text>
                    </HStack>
                  ) : profiles.length === 0 ? (
                    <EmptyState
                      title="创建第一个 Agent"
                      description="连接一个飞书应用，再选择 Claude Code 或 Codex 作为执行引擎。"
                      icon={<Icon icon={CommandLineIcon} size="lg" color="secondary" />}
                      actions={<Button label="添加 Agent" variant="primary" onClick={() => setCreating(true)} />}
                    />
                  ) : visibleProfiles.length === 0 ? (
                    <EmptyState
                      title="没有匹配的 Agent"
                      description="尝试调整搜索词或运行状态筛选。"
                      actions={<Button label="清除筛选" onClick={() => { setQuery(""); setFilter("all"); }} />}
                    />
                  ) : (
                    <Grid columns={{ minWidth: 300, max: 3, repeat: "fit" }} gap={4}>
                      {visibleProfiles.map((profile) => (
                        <Card key={profile.name} padding={0} elevation="low">
                          <Section variant={profile.running ? "section" : "muted"} padding={5}>
                            <VStack gap={5}>
                              <HStack gap={3} hAlign="between" vAlign="start">
                                <HStack gap={3} vAlign="center">
                                  <Icon
                                    icon={profile.running ? BoltIcon : CommandLineIcon}
                                    size="lg"
                                    color={profile.running ? "success" : "secondary"}
                                  />
                                  <VStack gap={0.5}>
                                    <Heading level={3}>{profile.name}</Heading>
                                    <StatusDot
                                      variant={profile.running ? "success" : "neutral"}
                                      label={profile.running ? "渠道已连接" : "当前未运行"}
                                      isPulsing={profile.running}
                                    />
                                  </VStack>
                                </HStack>
                                <Badge
                                  variant="neutral"
                                  label={profile.agentKind === "codex" ? "Codex" : "Claude"}
                                />
                              </HStack>
                              <Divider />
                              <HStack gap={2} hAlign="end" vAlign="center" wrap="wrap">
                                {profile.running ? (
                                  <Button
                                    label="停止"
                                    variant="ghost"
                                    size="sm"
                                    icon={<Icon icon={PauseIcon} size="sm" />}
                                    onClick={() => setStopTarget(profile.name)}
                                  />
                                ) : (
                                  <Button
                                    label="启动"
                                    variant="secondary"
                                    size="sm"
                                    isLoading={busy === profile.name}
                                    isDisabled={busy === profile.name}
                                    onClick={() => void start(profile.name)}
                                  />
                                )}
                                <Button
                                  label="打开工作区"
                                  variant="primary"
                                  size="sm"
                                  icon={<Icon icon={ArrowRightIcon} size="sm" />}
                                  onClick={() => onOpen(profile.name)}
                                />
                              </HStack>
                            </VStack>
                          </Section>
                        </Card>
                      ))}
                    </Grid>
                  )}
                </VStack>
              </Section>
            </VStack>
          </LayoutContent>
        }
      />

      <Dialog isOpen={creating} onOpenChange={setCreating} width={640} purpose="form">
        <Layout
          header={<DialogHeader title="添加 Agent" onOpenChange={setCreating} />}
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
        title={`停止 ${stopTarget ?? "Agent"}？`}
        description="该 Agent 会断开渠道连接，并停止接收新消息；之后可以从工作台重新启动。"
        cancelLabel="继续运行"
        actionLabel="停止 Agent"
        isActionLoading={stopping}
        onAction={() => void confirmStop()}
      />
    </>
  );
}
