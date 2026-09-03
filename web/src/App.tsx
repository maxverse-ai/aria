import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import {
  Layout,
  LayoutContent,
  LayoutFooter,
} from "@astryxdesign/core/Layout";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ToastViewport } from "@astryxdesign/core/Toast";
import {
  CircleStackIcon,
  CalendarDaysIcon,
  CommandLineIcon,
  CpuChipIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { apiGet } from "@/lib/api";
import type { OnboardState, Status } from "@/lib/types";
import { ProfilesView } from "@/views/ProfilesView";
import { ProfileDetail } from "@/views/ProfileDetail";
import { OnboardWizard } from "@/views/OnboardWizard";
import { TriggersView } from "@/views/TriggersView";

const TRIGGERS_ROUTE = "__triggers__";

export function App() {
  const [onboard, setOnboard] = useState<OnboardState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const os = await apiGet<OnboardState>("/api/onboard/state");
      setOnboard(os);
      if (os.hasConfig) {
        setStatus(await apiGet<Status>("/api/status").catch(() => null));
      }
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const shell = (children: ReactNode) => (
    <ConsoleShell
      profiles={onboard?.profiles ?? []}
      status={status}
      selected={selected}
      onSelect={setSelected}
    >
      {children}
    </ConsoleShell>
  );

  if (error) {
    return shell(
      <EmptyState
        title="控制台连接失败"
        description={error}
        actions={<Button label="重新加载" variant="primary" onClick={() => void refresh()} />}
      />,
    );
  }

  if (!onboard) {
    return shell(
      <Card padding={8}>
        <HStack gap={3} hAlign="center" vAlign="center">
          <Spinner label="正在加载控制台" />
          <Text color="secondary">正在连接 Aria supervisor…</Text>
        </HStack>
      </Card>,
    );
  }

  if (!onboard.hasConfig) {
    return shell(
      <VStack gap={5}>
        <VStack gap={1}>
          <Text type="supporting" color="accent" weight="semibold">首次设置</Text>
          <Heading level={1}>初始化 AI 助手</Heading>
          <Text color="secondary">创建第一个飞书应用并绑定本地 Agent。</Text>
        </VStack>
        <Card padding={6} maxWidth={720}>
          <OnboardWizard onCreated={() => void refresh()} />
        </Card>
      </VStack>,
    );
  }

  return shell(
    selected === TRIGGERS_ROUTE ? (
      <TriggersView profiles={onboard.profiles} />
    ) : selected ? (
      <ProfileDetail
        profile={selected}
        onBack={() => {
          setSelected(null);
          void refresh();
        }}
      />
    ) : (
      <ProfilesView
        status={status}
        onOpen={setSelected}
        onProfilesChanged={() => void refresh()}
      />
    ),
  );
}

function ConsoleShell({
  children,
  profiles,
  status,
  selected,
  onSelect,
}: {
  children: ReactNode;
  profiles: string[];
  status: Status | null;
  selected: string | null;
  onSelect: (profile: string | null) => void;
}) {
  const navigation = (
    <>
      <SideNavSection title="控制台" isHeaderHidden>
        <SideNavItem
          label="运行总览"
          icon={Squares2X2Icon}
          isSelected={selected === null}
          onClick={() => onSelect(null)}
        />
        <SideNavItem
          label="定时任务"
          icon={CalendarDaysIcon}
          isSelected={selected === TRIGGERS_ROUTE}
          onClick={() => onSelect(TRIGGERS_ROUTE)}
        />
      </SideNavSection>
      <SideNavSection title="Profiles">
        {profiles.map((profile) => (
          <SideNavItem
            key={profile}
            label={profile}
            icon={CpuChipIcon}
            isSelected={selected === profile}
            onClick={() => onSelect(profile)}
          />
        ))}
      </SideNavSection>
    </>
  );

  return (
    <ToastViewport position="bottomEnd" maxVisible={4}>
      <AppShell
        variant="elevated"
        contentPadding={0}
        height="fill"
        mobileNav={{ breakpoint: "md", content: navigation }}
        sideNav={
          <SideNav
            collapsible
            resizable={{ defaultWidth: 272, minWidth: 232, maxWidth: 360, autoSaveId: "aria-console-nav" }}
            header={
              <SideNavHeading
                superheading="Supervisor"
                heading="Aria Console"
                subheading={status ? `v${status.version}` : "正在连接"}
                icon={
                  <NavIcon
                    icon={<Icon icon={CommandLineIcon} size="sm" color="accent" />}
                  />
                }
              />
            }
            footer={
              <SideNavSection title="系统状态" isHeaderHidden>
                <SideNavItem
                  label={status ? `${status.online} 个 profile 在线` : "连接 supervisor"}
                  icon={
                    <StatusDot
                      variant={status ? "success" : "warning"}
                      label={status ? "Supervisor 在线" : "正在连接 supervisor"}
                    />
                  }
                  endContent={<Icon icon={CircleStackIcon} size="sm" color="secondary" />}
                />
              </SideNavSection>
            }
          >
            {navigation}
          </SideNav>
        }
      >
        <Layout
          height="fill"
          contentWidth={1280}
          content={<LayoutContent padding={6}>{children}</LayoutContent>}
          footer={
            status ? (
              <LayoutFooter padding={3} hasDivider>
                <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap">
                  <HStack gap={2} vAlign="center">
                    <StatusDot variant="success" label="Supervisor 运行正常" />
                    <Text type="supporting" color="secondary">单主进程托管所有 profile</Text>
                  </HStack>
                  <Text type="supporting" color="secondary">
                    在线配置即时生效 · Aria v{status.version}
                  </Text>
                </HStack>
              </LayoutFooter>
            ) : undefined
          }
        />
      </AppShell>
    </ToastViewport>
  );
}
