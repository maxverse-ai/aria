import { useCallback, useEffect, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import {
  Layout,
  LayoutContent,
  LayoutHeader,
} from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import {
  ArrowLeftIcon,
  BoltIcon,
  ClockIcon,
  CommandLineIcon,
  CpuChipIcon,
  PlayIcon,
  StopIcon,
} from "@heroicons/react/24/outline";
import { apiGet, apiPost } from "@/lib/api";
import type { BotInfo, ProfileInfo } from "@/lib/types";
import { ConfigView } from "./ConfigView";

function uptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function ProfileDetail({ profile, onBack }: { profile: string; onBack: () => void }) {
  const [info, setInfo] = useState<ProfileInfo | null>(null);
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const showToast = useToast();

  const loadRuntime = useCallback(async () => {
    const [profileData, botData] = await Promise.all([
      apiGet<{ profiles: ProfileInfo[] }>("/api/profiles").catch(() => ({ profiles: [] })),
      apiGet<{ bots: BotInfo[] }>("/api/bots").catch(() => ({ bots: [] })),
    ]);
    setInfo(profileData.profiles.find((entry) => entry.name === profile) ?? null);
    setBots(botData.bots.filter((bot) => bot.profileName === profile));
  }, [profile]);

  useEffect(() => {
    void loadRuntime();
    const timer = setInterval(() => void loadRuntime(), 5_000);
    return () => clearInterval(timer);
  }, [loadRuntime]);

  async function confirmStop() {
    setStopping(true);
    try {
      await apiPost("/api/profiles/stop", { profile });
      showToast({ body: `已停止 ${profile}` });
      setConfirm(false);
      setTimeout(() => void loadRuntime(), 500);
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setStopping(false);
    }
  }

  async function start() {
    setStarting(true);
    try {
      await apiPost("/api/profiles/start", { profile });
      showToast({ body: `已启动 ${profile}` });
      setTimeout(() => void loadRuntime(), 500);
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setStarting(false);
    }
  }

  const running = info?.running ?? bots.length > 0;
  const longestUptime = bots.reduce((max, bot) => Math.max(max, bot.uptimeMs), 0);

  return (
    <VStack gap={6}>
      <HStack gap={4} hAlign="between" vAlign="start" wrap="wrap">
        <HStack gap={3} vAlign="start">
          <Button
            label="返回运行总览"
            variant="ghost"
            isIconOnly
            icon={<Icon icon={ArrowLeftIcon} size="sm" />}
            onClick={onBack}
          />
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Heading level={1}>{profile}</Heading>
              {info && <Badge variant="neutral" label={info.agentKind} />}
              <Badge variant={running ? "success" : "neutral"} label={running ? "在线" : "未运行"} />
            </HStack>
            <Text color="secondary">运行状态、接入信息与完整配置。</Text>
          </VStack>
        </HStack>
        {running ? (
          <Button
            label="停止 Profile"
            variant="destructive"
            icon={<Icon icon={StopIcon} size="sm" />}
            onClick={() => setConfirm(true)}
          />
        ) : (
          <Button
            label="启动 Profile"
            variant="primary"
            icon={<Icon icon={PlayIcon} size="sm" />}
            isLoading={starting}
            isDisabled={starting}
            onClick={() => void start()}
          />
        )}
      </HStack>

      <Grid columns={{ minWidth: 220, max: 3, repeat: "fit" }} gap={3}>
        <StatusCard
          label="运行状态"
          value={running ? "Healthy" : "Stopped"}
          description={running ? "Supervisor 正在托管" : "等待手动启动"}
          icon={BoltIcon}
          status={running ? "success" : "neutral"}
        />
        <StatusCard
          label="Bot 进程"
          value={bots.length}
          description={bots.length ? "已连接的运行实例" : "暂无活动进程"}
          icon={CpuChipIcon}
          status={bots.length ? "success" : "neutral"}
        />
        <StatusCard
          label="最长运行"
          value={longestUptime ? uptime(longestUptime) : "—"}
          description="每 5 秒更新一次"
          icon={ClockIcon}
          status={running ? "success" : "neutral"}
        />
      </Grid>

      <Card padding={0}>
        <Layout
          header={
            <LayoutHeader padding={4} hasDivider>
              <HStack hAlign="between" vAlign="center" gap={3}>
                <VStack gap={0.5}>
                  <Heading level={2}>运行实例</Heading>
                  <Text type="supporting" color="secondary">来自 supervisor 的实时进程快照</Text>
                </VStack>
                <StatusDot
                  variant={running ? "success" : "neutral"}
                  label={running ? "Profile 在线" : "Profile 未运行"}
                  isPulsing={running}
                />
              </HStack>
            </LayoutHeader>
          }
          content={
            <LayoutContent padding={bots.length ? 0 : 4}>
              {bots.length === 0 ? (
                <EmptyState
                  title="没有运行中的 Bot"
                  description="启动后，进程、版本与运行时长会显示在这里。"
                  icon={<Icon icon={CommandLineIcon} size="lg" color="secondary" />}
                  actions={
                    <Button
                      label="启动 Profile"
                      variant="primary"
                      isLoading={starting}
                      isDisabled={starting}
                      onClick={() => void start()}
                    />
                  }
                  isCompact
                />
              ) : (
                <List density="spacious" hasDividers>
                  {bots.map((bot) => (
                    <ListItem
                      key={bot.id}
                      label={bot.botName ?? "正在连接"}
                      description={`${bot.agentKind} · ${bot.profileName}`}
                      startContent={<StatusDot variant="success" label="进程在线" isPulsing />}
                      endContent={
                        <MetadataList orientation="horizontal">
                          <MetadataListItem label="PID">{bot.pid}</MetadataListItem>
                          <MetadataListItem label="运行">{uptime(bot.uptimeMs)}</MetadataListItem>
                          <MetadataListItem label="版本">v{bot.version}</MetadataListItem>
                        </MetadataList>
                      }
                    />
                  ))}
                </List>
              )}
            </LayoutContent>
          }
        />
      </Card>

      <VStack gap={1}>
        <Heading level={2}>Profile 配置</Heading>
        <Text color="secondary">按设置面板分组管理回复、身份、访问控制和会议能力。</Text>
      </VStack>

      <ConfigView profile={profile} />

      <AlertDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title={`停止 ${profile}？`}
        description="将停止该 profile 正在运行的 bot；若它是后台服务，也会禁用自动重启。之后可随时重新启动。"
        cancelLabel="取消"
        actionLabel="确认停止"
        isActionLoading={stopping}
        onAction={() => void confirmStop()}
      />
    </VStack>
  );
}

function StatusCard({
  label,
  value,
  description,
  icon,
  status,
}: {
  label: string;
  value: string | number;
  description: string;
  icon: typeof BoltIcon;
  status: "success" | "neutral";
}) {
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center">
          <Text type="label" color="secondary">{label}</Text>
          <Icon icon={icon} size="sm" color={status === "success" ? "success" : "secondary"} />
        </HStack>
        <HStack gap={2} vAlign="center">
          <StatusDot variant={status} label={String(value)} />
          <Heading level={2}>{value}</Heading>
        </HStack>
        <Text type="supporting" color="secondary">{description}</Text>
      </VStack>
    </Card>
  );
}
